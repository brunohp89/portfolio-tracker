"""Print the current balance of every BudgetBakers Wallet account.

Balances come from the Wallet REST API, where they are computed by Wallet as
``initial + incomes - expenses`` over the imported (posted) records. Pending
transactions are not exposed by the API, so they are not included.

Investment accounts are skipped: the portfolio tracker values them from
market prices.

For credit cards the script reports the amount owed, the credit limit and the
utilization. Limits set in Wallet are used unless overridden by the
``WALLET_CREDIT_LIMITS`` environment variable, a JSON object mapping Wallet
account names to limits (kept out of the code because the repo is public).

It also flags likely duplicate records, because a duplicate silently shifts a
computed balance.

Usage:
    WALLET_API_TOKEN=... WALLET_CREDIT_LIMITS='{"Card name": 2000}' \\
        python tools/wallet_balances.py [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

API_BASE = "https://rest.budgetbakers.com/wallet/v1/api"
PAGE_SIZE = 200
MAX_PAGES = 200  # safety bound: a nextOffset that never moves forward would loop forever
DUPLICATE_LOOKBACK_DAYS = 120
TIMEOUT_S = 60


def credit_limit_overrides() -> dict[str, float]:
    """Credit limits keyed by Wallet account name, from WALLET_CREDIT_LIMITS (JSON)."""
    raw = os.environ.get("WALLET_CREDIT_LIMITS", "").strip()
    if not raw:
        return {}
    try:
        return {str(k): float(v) for k, v in json.loads(raw).items()}
    except (ValueError, AttributeError, TypeError) as exc:
        raise SystemExit(f"WALLET_CREDIT_LIMITS is not a JSON object of numbers: {exc}") from exc


MANUAL_SOURCES = {"android", "ios", "web", "rest", "mcp"}

# Valued by the portfolio tracker from market prices, not from Wallet.
EXCLUDED_ACCOUNT_TYPES = {"Investment"}


@dataclass(frozen=True)
class AccountBalance:
    name: str
    account_type: str
    currency: str
    bank_sync: bool
    balance: float  # signed: negative means money owed
    last_record_date: str | None
    credit_owed: float | None = None
    credit_limit: float | None = None
    credit_available: float | None = None
    utilization_pct: float | None = None


@dataclass(frozen=True)
class DuplicateGroup:
    account: str
    record_date: str
    amount: float
    count: int
    note: str
    balance_impact: float  # effect of the extra copies on the balance


class WalletApiError(RuntimeError):
    pass


def _get_json(url: str, token: str | None = None) -> tuple[dict[str, Any], dict[str, str]]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.load(response), dict(response.headers)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        if exc.code == 409:
            raise WalletApiError("Wallet initial sync still in progress, retry in a few minutes") from exc
        if exc.code == 429:
            raise WalletApiError(f"Rate limited, retry after {exc.headers.get('Retry-After', '?')} s") from exc
        raise WalletApiError(f"HTTP {exc.code} for {url}: {body}") from exc


def _paginate(path: str, key: str, token: str, params: list[tuple[str, str]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    for _ in range(MAX_PAGES):
        query = urllib.parse.urlencode([*params, ("limit", str(PAGE_SIZE)), ("offset", str(offset))])
        payload, _ = _get_json(f"{API_BASE}/{path}?{query}", token)
        page = payload.get(key, [])
        items.extend(page)
        next_offset = payload.get("nextOffset")
        if not page or next_offset is None or int(next_offset) <= offset:
            return items
        offset = int(next_offset)
    raise WalletApiError(f"{path}: more than {MAX_PAGES} pages, stopping")


def fetch_accounts(token: str) -> list[dict[str, Any]]:
    accounts = _paginate("accounts", "accounts", token, [("archived", "false")])
    return [
        a for a in accounts
        if a["accountType"] not in EXCLUDED_ACCOUNT_TYPES and not a.get("isInvestmentAccount")
    ]


def fetch_records(token: str, since: date) -> list[dict[str, Any]]:
    return _paginate("records", "records", token, [("recordDate", f"gte.{since.isoformat()}")])


def build_balance(account: dict[str, Any], limits: dict[str, float]) -> AccountBalance:
    balance = account.get("balance") or {}
    # rawCurrentBalance is the signed ledger value; Wallet's display formula for
    # bank-synced cards applies -abs(), which would turn an overpayment into debt.
    raw_value = balance.get("rawCurrentBalance")
    if raw_value is None:  # same fallback as the Worker (`??`): a null field must not crash float()
        raw_value = balance.get("currentBalance")
    raw = float(raw_value or 0.0)
    last = ((account.get("recordStats") or {}).get("recordDate") or {}).get("max")
    common = dict(
        name=account["name"],
        account_type=account["accountType"],
        currency=account["currencyCode"],
        bank_sync=bool(account.get("isBankSync")),
        balance=round(raw, 2),
        last_record_date=last[:10] if last else None,
    )
    if account["accountType"] != "CreditCard":
        return AccountBalance(**common)

    owed = round(max(0.0, -raw), 2)
    limit = limits.get(account["name"]) or float(balance.get("creditLimit") or 0.0) or None
    return AccountBalance(
        **common,
        credit_owed=owed,
        credit_limit=limit,
        credit_available=round(limit - owed, 2) if limit else None,
        utilization_pct=round(100.0 * owed / limit, 1) if limit else None,
    )


def find_duplicates(records: list[dict[str, Any]]) -> list[DuplicateGroup]:
    """Flag records sharing account, date and amount that were not created together.

    Copies created in the same import batch (e.g. several identical ATM
    withdrawals or transit fares on one day) are treated as genuine. Copies
    imported on different days, or one imported and one entered by hand, are
    likely duplicates.
    """
    groups: dict[tuple[str, str, float], list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        account = record.get("accountName") or record.get("accountId") or "?"
        key = (account, record["recordDate"][:10], float(record["amount"]["value"]))
        groups[key].append(record)

    flagged: list[DuplicateGroup] = []
    for (account, record_date, amount), items in groups.items():
        if len(items) < 2:
            continue
        created_days = {item["createdAt"][:10] for item in items}
        sources = {"manual" if item.get("source") in MANUAL_SOURCES else "bank" for item in items}
        if len(created_days) > 1 or len(sources) > 1:
            flagged.append(
                DuplicateGroup(
                    account=account,
                    record_date=record_date,
                    amount=amount,
                    count=len(items),
                    note=(items[0].get("note") or "")[:40],
                    balance_impact=round(amount * (len(items) - 1), 2),
                )
            )
    return sorted(flagged, key=lambda g: (g.account, g.record_date))


def fetch_eurusd(token: str, accounts: list[dict[str, Any]]) -> tuple[float, str] | None:
    """EURUSD from Wallet's own conversion of the latest EUR record.

    Wallet converts each record at the rate of its record date, so the rate is
    as fresh as the latest EUR transaction. Returns (rate, rate_date).
    """
    eur_ids = [a["id"] for a in accounts if a["currencyCode"] == "EUR"]
    if not eur_ids:
        return None
    query = urllib.parse.urlencode(
        [("accountId", ",".join(eur_ids[:10])), ("convertTo", "USD"), ("sortBy", "-recordDate"), ("limit", "1"),
         ("recordDate", f"gte.{(date.today() - timedelta(days=90)).isoformat()}")]
    )
    try:
        payload, _ = _get_json(f"{API_BASE}/records?{query}", token)
        record = payload["records"][0]
        return float(record["convertedAmount"]["ratio"]), record["recordDate"][:10]
    except (WalletApiError, urllib.error.URLError, KeyError, IndexError, TypeError, ValueError):
        return None


def _fmt(value: float | None, suffix: str = "") -> str:
    return "" if value is None else f"{value:,.2f}{suffix}"


def render(
    balances: list[AccountBalance], duplicates: list[DuplicateGroup], fx: tuple[float, str] | None
) -> str:
    lines = [f"Wallet balances as of {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC (posted transactions only)", ""]
    header = f"{'Account':34} {'Type':14} {'Cur':3} {'Balance':>12} {'Owed':>9} {'Limit':>9} {'Avail':>9} {'Util':>6}  {'Last tx':10} Src"
    lines += [header, "-" * len(header)]
    for b in sorted(balances, key=lambda x: (x.currency, x.account_type, x.name)):
        lines.append(
            f"{b.name[:34]:34} {b.account_type[:14]:14} {b.currency:3} {_fmt(b.balance):>12} "
            f"{_fmt(b.credit_owed):>9} {_fmt(b.credit_limit):>9} {_fmt(b.credit_available):>9} "
            f"{_fmt(b.utilization_pct, '%'):>6}  {b.last_record_date or '':10} {'bank' if b.bank_sync else 'manual'}"
        )

    totals: dict[str, float] = defaultdict(float)
    for b in balances:
        totals[b.currency] += b.balance
    lines += ["", "Totals by currency: " + ", ".join(f"{c} {_fmt(v)}" for c, v in sorted(totals.items()))]
    if fx and set(totals) <= {"USD", "EUR"}:
        rate, rate_date = fx
        usd_total = totals["USD"] + totals["EUR"] * rate
        lines.append(
            f"Grand total @ EURUSD {rate:.4f} ({rate_date}): USD {_fmt(usd_total)} | EUR {_fmt(usd_total / rate)}"
        )
    else:
        lines.append("Grand total skipped: EURUSD rate unavailable")

    cards = [b for b in balances if b.credit_limit]
    if cards:
        owed = sum(b.credit_owed or 0.0 for b in cards)
        limit = sum(b.credit_limit or 0.0 for b in cards)
        lines.append(f"Overall credit utilization: {_fmt(owed)} / {_fmt(limit)} = {100 * owed / limit:.1f}%")

    if duplicates:
        lines += ["", f"Possible duplicate records (last {DUPLICATE_LOOKBACK_DAYS} days), check them in Wallet:"]
        for d in duplicates:
            lines.append(
                f"  {d.account[:34]:34} {d.record_date} {d.amount:>10,.2f} x{d.count}  "
                f"impact {d.balance_impact:+,.2f}  {d.note}"
            )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", metavar="PATH", help="also write balances and duplicates as JSON")
    args = parser.parse_args()

    token = os.environ.get("WALLET_API_TOKEN")
    if not token:
        print("WALLET_API_TOKEN is not set", file=sys.stderr)
        return 2

    try:
        accounts = fetch_accounts(token)
        limits = credit_limit_overrides()
        balances = [build_balance(a, limits) for a in accounts]
        since = date.today() - timedelta(days=DUPLICATE_LOOKBACK_DAYS)
        account_ids = {a["id"] for a in accounts}
        records = [r for r in fetch_records(token, since) if r.get("accountId") in account_ids]
        duplicates = find_duplicates(records)
    except (WalletApiError, urllib.error.URLError) as exc:
        print(f"Wallet API error: {exc}", file=sys.stderr)
        return 1

    fx = fetch_eurusd(token, accounts)
    print(render(balances, duplicates, fx))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "eurusd": {"rate": fx[0], "as_of": fx[1]} if fx else None,
                    "accounts": [asdict(b) for b in balances],
                    "possible_duplicates": [asdict(d) for d in duplicates],
                },
                fh,
                indent=2,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
