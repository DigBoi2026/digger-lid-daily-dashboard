#!/usr/bin/env python3
"""Render the forecast bundle from source/export_forecast.js into a workbook.

Formatting only. Every number here was computed by forecast.js — the same module
the board runs in the browser — because a second implementation of the model in
Python would be a second set of answers to the same question.

    node source/export_forecast.js --live live.json --out bundle.json
    python3 source/export_forecast.py bundle.json DiggerLid_Forecast.xlsx
"""
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

YELLOW = "F5EB19"
INK    = "1A1617"
GREY   = "6E6768"
BAND   = "FBF8D6"
GOOD   = "1C6B41"
BAD    = "B3231B"

H1   = Font(name="Calibri", size=16, bold=True, color=INK)
HEAD = Font(name="Calibri", size=10, bold=True, color=INK)
BODY = Font(name="Calibri", size=10)
MUTE = Font(name="Calibri", size=9, color=GREY)
BOLD = Font(name="Calibri", size=10, bold=True)
FILL_HEAD = PatternFill("solid", fgColor=YELLOW)
FILL_BAND = PatternFill("solid", fgColor=BAND)
THIN = Side(style="thin", color="D9D4D5")
BOX  = Border(bottom=THIN)

MONEY = '"$"#,##0'
MONEY2 = '"$"#,##0.00'
PCT = '0.0%'
MULT = '0.00"x"'
NUM = '#,##0'
IDX = '0.00'


def sheet(wb, title, subtitle=None):
    ws = wb.create_sheet(title)
    ws.sheet_view.showGridLines = False
    ws["A1"] = title
    ws["A1"].font = H1
    if subtitle:
        ws["A2"] = subtitle
        ws["A2"].font = MUTE
    ws.freeze_panes = "A5"
    return ws


def table(ws, row, cols, rows, widths=None, note=None):
    """cols: list of (header, key, number_format). rows: list of dicts."""
    for i, (label, _key, _fmt) in enumerate(cols, start=1):
        c = ws.cell(row=row, column=i, value=label)
        c.font = HEAD
        c.fill = FILL_HEAD
        c.alignment = Alignment(horizontal="left" if i == 1 else "right", wrap_text=True)
        c.border = BOX
    for r, item in enumerate(rows, start=row + 1):
        for i, (_label, key, fmt) in enumerate(cols, start=1):
            v = item.get(key) if isinstance(item, dict) else None
            c = ws.cell(row=r, column=i, value=v)
            c.font = BOLD if i == 1 else BODY
            if fmt:
                c.number_format = fmt
            if i > 1:
                c.alignment = Alignment(horizontal="right")
        if (r - row) % 2 == 0:
            for i in range(1, len(cols) + 1):
                ws.cell(row=r, column=i).fill = FILL_BAND
    end = row + len(rows)
    for i, w in enumerate(widths or [], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    if note:
        c = ws.cell(row=end + 2, column=1, value=note)
        c.font = MUTE
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=end + 2, start_column=1,
                       end_row=end + 4, end_column=max(4, len(cols)))
    return end


def kv(ws, row, pairs, width=(34, 20, 74)):
    """A label / value / why block — the shape most of this export wants."""
    for i, w in enumerate(width, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for label, value, fmt, why in pairs:
        if label is None:                      # a section break
            c = ws.cell(row=row, column=1, value=why)
            c.font = Font(name="Calibri", size=11, bold=True, color=INK)
            c.fill = FILL_HEAD
            ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
            row += 1
            continue
        ws.cell(row=row, column=1, value=label).font = BOLD
        c = ws.cell(row=row, column=2, value=value)
        c.font = BODY
        c.alignment = Alignment(horizontal="right")
        if fmt:
            c.number_format = fmt
        c2 = ws.cell(row=row, column=3, value=why)
        c2.font = MUTE
        c2.alignment = Alignment(wrap_text=True, vertical="top")
        row += 1
    return row


def build(b, out):
    wb = Workbook()
    wb.remove(wb.active)
    m = b["meta"]
    ba = b["basis"]
    pnl = ba["pnl"]
    acc = ba["accuracy"]

    # ---------------------------------------------------------------- summary
    ws = sheet(wb, "Summary",
               "Forecast from %s to %s (%d days) · data through %s · %s"
               % (m["from"], m["to"], m["horizon"], m["dataThrough"],
                  "live pull" if m["live"] else "committed snapshot"))
    row = 5
    row = table(ws, row,
                [("Scenario", "scenario", None), ("Revenue", "revenue", MONEY),
                 ("Ad spend", "adSpend", MONEY), ("Profit", "profit", MONEY),
                 ("Margin", "margin", PCT), ("MER", "mer", MULT),
                 ("Same dates last year", "priorYear", MONEY), ("vs last year", "vsPriorYear", MULT)],
                b["headline"], widths=[16, 15, 14, 14, 10, 9, 20, 13],
                note="Each scenario is an ASSUMPTION, not a percentage applied to one number. "
                     "Realistic: the current trajectory continues and events repeat as they have. "
                     "Optimistic: growth holds at its full year-on-year rate and the big months scale with it. "
                     "Pessimistic: growth stops dead and the big months land 15% short. "
                     "Costs are identical across all three on purpose — what is uncertain is demand, not the "
                     "cost structure, and holding costs still is what shows the operating leverage.")
    row += 6
    ws.cell(row=row, column=1, value="What it rests on").font = H1
    row += 1
    row = kv(ws, row, [
        (None, None, None, "TODAY'S POSITION"),
        ("Underlying run rate", ba["level"], MONEY,
         "Per day, from the last 28 complete days with season and weekday removed. Pending days "
         "excluded, and any declared sale period divided out."),
        ("Drift", ba["drift"], MULT,
         "Per 28 days — implies x%.2f a year. Bounded by the best year-on-year month recorded, "
         "because a growth rate should not imply growth the business has never achieved."
         % ba["driftAnnual"]),
        ("Year-on-year growth", ba["growth"]["yoy"], MULT,
         "Median of %d whole months compared like for like, range x%.2f to x%.2f. Only whole "
         "months count." % (ba["growth"]["n"], ba["growth"]["low"], ba["growth"]["high"])),
        ("Weight on last year", ba["priorWeight"], PCT,
         "How much of each forecast day comes from the same days last year rather than from "
         "today's trajectory. Decays with distance."),
        (None, None, None, "COST STRUCTURE — the profit identity, exact in the sheet"),
        ("Contribution rate", pnl["contribRate"], PCT,
         "Of revenue, after GST and variable costs. profit = revenue ex GST - variable - ads - fixed."),
        ("Ad spend rate", pnl["adRate"], PCT,
         "Of revenue, then shaped by month: the big months are the efficient ones."),
        ("Fixed cost per day", pnl["fcPerDay"], MONEY,
         "The LATEST step, not an average (%s over the trailing window). Fixed cost is a "
         "staircase — it has only ever gone up — and an average would bill the rest of the year "
         "at a headcount the business no longer has."
         % ("${:,.0f}".format(pnl["fcPerDayAvg"]))),
        ("Breakeven revenue", b["headline"][1]["breakevenPerDay"], MONEY,
         "Per day, to cover ad spend and fixed cost and nothing more. "
         "That is %s a month just to stand still." % ("${:,.0f}".format(b["headline"][1]["breakevenPerDay"] * 30))),
        (None, None, None, "MEASURED ACCURACY — walked forward through the book, refitting at each origin"),
    ])
    for h in ("30", "60", "90"):
        a = acc.get(h)
        if not a:
            continue
        row = kv(ws, row, [("Error at %s days" % h, a["mape"], PCT,
                            "Across %d past starting points, running %s by %.0f%% on average. "
                            "Range p10 %.0f%% to p90 %.0f%%."
                            % (a["n"], "low" if a["bias"] < 0 else "high",
                               abs(a["bias"] * 100), a["p10"] * 100, a["p90"] * 100))])
    cold = (acc.get("30") or {}).get("coldStart")
    if cold:
        row = kv(ws, row, [("With no prior year", cold["mape"], PCT,
                            "What the same model scored from %d starting points in 2025, which had no "
                            "BFCM anywhere in their history. This is the cost of a short book."
                            % cold["n"])])
    row += 1
    row = kv(ws, row, [(None, None, None, "WHAT THIS CANNOT DO")])
    nov = ba["seasonObservations"].get("11", 0)
    limits = [
        "October to December are unvalidated. No starting point in the data has a horizon that "
        "reaches them, so BFCM — the single largest claim in this workbook — is untested by "
        "backtest and rests on %d observed November%s. Standing at 4 November 2025, with nothing "
        "in its history that had ever seen a BFCM, the model missed the following 30 days by -58%%."
        % (nov, "" if nov == 1 else "s"),
        "Months never filled into the 2025 workbook (%s) are fitted on 2026 alone."
        % (", ".join(m["monthsMissing"]) or "none"),
        "The month figures step at month boundaries. BFCM decays over days in real life; here "
        "30 November to 1 December is a cliff, softened only by the prior-year half of the blend.",
        "It cannot see a decision it has not been told about. The 2026 Father's Day promotion was "
        "invisible to every model until it was declared as a sale period.",
        "It is a forecast, not a commitment. Two years is a short book, and one of them has "
        "three months missing.",
    ]
    for text in limits:
        c = ws.cell(row=row, column=1, value="•")
        c.font = BOLD
        c2 = ws.cell(row=row, column=2, value=text)
        c2.font = MUTE
        c2.alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=row, start_column=2, end_row=row + 1, end_column=3)
        row += 2

    # ------------------------------------------------------------ by month
    ws = sheet(wb, "Forecast by month", "All three scenarios · compared against the SAME DATES last year, never the same month")
    table(ws, 5,
          [("Month", "month", None), ("Days", "days", NUM),
           ("Pessimistic", "pessimisticRevenue", MONEY),
           ("Realistic", "realisticRevenue", MONEY),
           ("Optimistic", "optimisticRevenue", MONEY),
           ("Same dates last yr", "priorYearSameDates", MONEY),
           ("vs last yr", "vsPriorYear", MULT),
           ("Ad spend", "adSpend", MONEY), ("Fixed cost", "fixedCost", MONEY),
           ("Profit", "realisticProfit", MONEY), ("Margin", "margin", PCT),
           ("MER", "mer", MULT), ("Season index", "seasonIndex", IDX),
           ("Years observed", "yearsObserved", NUM)],
          b["months"],
          widths=[11, 7, 14, 14, 14, 18, 11, 13, 12, 13, 9, 8, 13, 14],
          note="Ad spend, fixed cost, profit, margin and MER are the REALISTIC case. "
               "'Years observed' is the sample size behind that month's season index — where it "
               "reads 1, the figure rests on a single year, and November is the one the year-end "
               "number leans on. A partial first month is compared to the same partial window last "
               "year: measuring a 22-day stub of September against a whole September once read a "
               "+132% month as -32%.")

    # ------------------------------------------------------------ daily
    ws = sheet(wb, "Forecast daily", "The realistic case day by day, with the other two for the band")
    table(ws, 5,
          [("Date", "date", "yyyy-mm-dd"), ("Day", "dow", None),
           ("Pessimistic", "pessimistic", MONEY2), ("Realistic", "realistic", MONEY2),
           ("Optimistic", "optimistic", MONEY2), ("Ad spend", "adSpend", MONEY2),
           ("Profit", "profit", MONEY2), ("Season index", "seasonIndex", IDX),
           ("Modifier", "modifier", IDX), ("Same date last yr", "priorYearSameDate", MONEY2),
           ("Years observed", "yearsObserved", NUM)],
          b["daily"],
          widths=[12, 6, 13, 13, 13, 12, 12, 13, 10, 17, 14],
          note="'Modifier' is the combined factor from every declared sale period and modifier on "
               "that day — 1.00 means nothing applies. Factors multiply, so two declarations over "
               "the same days compound.")

    # ------------------------------------------------------------ actuals
    ws = sheet(wb, "Actuals daily", "Both books merged: 2025 static, 2026 live where available")
    table(ws, 5,
          [("Date", "date", "yyyy-mm-dd"), ("Day", "dow", None),
           ("Revenue", "revenue", MONEY2), ("Rev ex GST", "revExGst", MONEY2),
           ("Orders", "orders", NUM), ("Sessions", "sessions", NUM),
           ("AOV", "aov", MONEY2), ("CVR %", "cvr", None),
           ("Ad spend", "totalAds", MONEY2), ("MER", "mer", None), ("ROAS", "roas", None),
           ("Variable cost", "totalVC", MONEY2), ("Fixed cost", "totalFC", MONEY2),
           ("Total expenses", "totalExp", MONEY2), ("Profit", "profit", MONEY2),
           ("Profit %", "profitPct", None), ("Pending", "pending", None)],
          b["actuals"],
          widths=[12, 10, 13, 13, 8, 10, 11, 8, 12, 8, 8, 14, 12, 15, 13, 10, 18],
          note="'Pending' names the figures the sheet has not finished for that day. A day with "
               "revenue typed but no ad spend makes every formula beneath it evaluate to $0.00, "
               "which is indistinguishable from a real zero — so those days are flagged here and "
               "excluded from the forecast's run rate rather than read as a collapse in spend.")

    # ------------------------------------------------------------ seasonality
    ws = sheet(wb, "Seasonality", "Year and month effects solved jointly on log daily revenue")
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    srows = [{"month": months[i], "index": ba["seasonIndex"].get(str(i + 1)),
              "n": ba["seasonObservations"].get(str(i + 1), 0)} for i in range(12)]
    end = table(ws, 5, [("Month", "month", None), ("Index", "index", IDX), ("Years observed", "n", NUM)],
                srows, widths=[10, 10, 14],
                note="An index of 1.00 is an average month. Solved jointly rather than one year at a "
                     "time because the two books are an unbalanced panel: 2025 holds nine months "
                     "including both giants, so its other months read low, while 2026 at an early "
                     "vantage held only small months and read high. Averaging those directly made "
                     "every figure wrong and under-forecast the following 30 days by 29-39%.")
    r = end + 7
    ws.cell(row=r, column=1, value="Weekly rhythm").font = H1
    dows = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
    table(ws, r + 1, [("Day", "day", None), ("Index", "index", IDX)],
          [{"day": dows[i], "index": ba["dowIndex"].get(str(i))} for i in range(7)],
          note="Fitted across both years: how a trade customer shops through the week does not "
               "change from one year to the next, and more days make it steadier.")
    r += 13
    ws.cell(row=r, column=1, value="Underlying level by year").font = H1
    table(ws, r + 1, [("Year", "year", None), ("Level per day", "level", MONEY)],
          [{"year": y, "level": v} for y, v in sorted(ba["yearLevel"].items())],
          note="The year effect from the same joint fit: the size of a typical day in that year, "
               "with the shape of the year removed.")

    # ------------------------------------------------------------ YoY
    ws = sheet(wb, "Year on year", "Like-for-like only — a partial month cannot masquerade as a collapse")
    table(ws, 5,
          [("Month", "month", None), ("Days", "days", NUM), ("Complete", "complete", None),
           ("Revenue", "revenue", MONEY), ("Prior year", "priorYear", MONEY), ("YoY", "yoy", MULT)],
          b["yoyByMonth"], widths=[11, 7, 11, 14, 14, 10],
          note="YoY is blank unless BOTH months are complete. The growth rate the forecast uses is "
               "the median of the complete ones.")

    # ------------------------------------------------------------ sale periods
    ws = sheet(wb, "Sale periods",
               "Measured from the book · recurring, dated by rule · the one thing the month index cannot carry")
    srows = []
    for s in b["salePeriods"]:
        srows.append({"name": s["name"], "start": s["start"], "end": s["end"],
                      "lift": s["lift"], "payback": s["payback"], "paybackEnd": s["paybackEnd"],
                      "measuredIn": s["measuredIn"], "own": "measured" if s["ownMeasurement"] else "carried forward",
                      "measuredLift": s["measuredLift"], "pulled": s["pulledForward"]})
    end = table(ws, 5,
                [("Sale period", "name", None), ("Run-up starts", "start", None), ("Event day", "end", None),
                 ("Lift", "lift", PCT), ("Payback", "payback", PCT), ("Payback ends", "paybackEnd", None),
                 ("Measured in", "measuredIn", None), ("Basis", "own", None),
                 ("Book's lift", "measuredLift", PCT), ("Days pulled forward", "pulled", "0.0")],
                srows, widths=[20, 14, 12, 9, 10, 14, 13, 16, 12, 19],
                note="Father's Day is a sale period rather than part of the seasonal trend because it "
                     "CANNOT be one: it is the first Sunday of September, its run-up sits in August and "
                     "its payback in September, so no per-month figure can hold it. EOFY and BFCM are "
                     "month-aligned, so the season index prices them exactly and declaring them again "
                     "would count them twice. Every declared period is divided out of history BEFORE "
                     "anything is fitted, so the run rate, the month index and the growth rate are all "
                     "baseline figures.")
    r = end + 7
    ws.cell(row=r, column=1, value="Measured per year").font = H1
    allrows = []
    for s in b["salePeriods"]:
        for y in s["allYears"]:
            allrows.append({"name": s["name"].rsplit(" ", 1)[0], "year": y["year"], "day": y["day"],
                            "lift": y["lift"], "payback": y["payback"],
                            "paybackDays": y["paybackDays"], "observed": y["paybackDaysObserved"]})
        break
    table(ws, r + 1,
          [("Sale period", "name", None), ("Year", "year", None), ("Event day", "day", None),
           ("Lift", "lift", PCT), ("Payback", "payback", PCT),
           ("Payback days", "paybackDays", NUM), ("Payback days observed", "observed", NUM)],
          allrows,
          note="Measured against the three pre-promotion weeks of that year's own August, "
               "deseasonalised. A year measuring under +5% ran no promotion worth the name and is "
               "left undeclared rather than inheriting another year's lift — carrying 2026's +47% "
               "onto 2025 deflated the prior year, inflated growth, and pushed the whole forecast "
               "UP by 24%. The payback window is derived from the debt: the days pulled forward, "
               "repaid at whatever the days after the event actually ran at.")
    r += len(allrows) + 8
    ws.cell(row=r, column=1, value="Run-up profile, day by day").font = H1
    prow = []
    for s in b["salePeriods"]:
        for o in s["profile"]:
            prow.append({"name": s["name"], "date": o["date"], "lift": o["lift"]})
    table(ws, r + 1, [("Sale period", "name", None), ("Date", "date", None), ("Lift", "lift", PCT)],
          prow,
          note="A ramp, not a flat block: 2026 opened at +26%, peaked at +77% four days later and "
               "eased to +9% by the day itself. Re-sizing a sale period for a future year scales "
               "this shape rather than flattening it — the shape is how the customers behave, the "
               "size is the business's decision.")

    ws = wb["Summary"]
    wb.active = wb.index(ws)
    wb.save(out)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    with open(sys.argv[1]) as f:
        bundle = json.load(f)
    print("wrote " + build(bundle, sys.argv[2]))
