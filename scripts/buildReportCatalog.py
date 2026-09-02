"""Build the stable 460-report runtime catalog from the supplied PDF handoff.

Usage:
  python scripts/buildReportCatalog.py "C:\\path\\Ai POS 460 Reports.pdf"
"""

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


CATEGORIES = [
    (1, 18, "Management & Executive Dashboards"),
    (19, 52, "Sales Reports"),
    (53, 89, "Stock & Inventory Reports"),
    (90, 112, "Stock Valuation & Profitability"),
    (113, 138, "Purchase & Supplier Reports"),
    (139, 161, "Transfer & Receive Reports"),
    (162, 185, "Product / Merchandise Reports"),
    (186, 208, "AI Sales Forecasting"),
    (209, 225, "AI Demand Forecasting"),
    (226, 238, "AI Inventory Forecasting"),
    (239, 248, "AI Stockout Intelligence"),
    (249, 260, "AI Overstock / Dead Stock"),
    (261, 280, "AI Reorder & Purchase"),
    (281, 298, "AI Transfer / Stock Reallocation"),
    (299, 314, "AI Pricing & Discount"),
    (315, 329, "AI Profit & Financial Intelligence"),
    (330, 337, "Actual vs AI Prediction"),
    (338, 363, "AI Anomaly / Smart Alerts"),
    (364, 383, "AI Product / Merchandise Intelligence"),
    (384, 395, "AI Supplier Intelligence"),
    (396, 415, "AI Management Decision Reports"),
    (416, 425, "Important 360° Screens"),
    (426, 452, "Core KPI Checklist"),
    (453, 456, "Target & Incentive Reports"),
    (457, 460, "FBR & GST Reports"),
]


def category_for(number):
    return next(name for start, end, name in CATEGORIES if start <= number <= end)


def dimension_for(name):
    text = name.lower()
    dimensions = [
        ("subdepartment", ("subdepartment", "sub department")),
        ("subcategory", ("subcategory", "sub category")),
        ("cobrand", ("cobrand", "co-brand")),
        ("salesman", ("salesman",)),
        ("supplier", ("supplier",)),
        ("department", ("department",)),
        ("category", ("category",)),
        ("barcode", ("barcode", "product", "sku")),
        ("design", ("design",)),
        ("branch", ("branch",)),
        ("store", ("store",)),
        ("brand", ("brand",)),
        ("season", ("season",)),
        ("fabric", ("fabric",)),
        ("gender", ("gender",)),
        ("size", ("size",)),
        ("color", ("color",)),
        ("style", ("style",)),
        ("day", ("daily", "day ")),
        ("week", ("weekly", "week")),
        ("month", ("monthly", "month")),
    ]
    return next((key for key, words in dimensions if any(word in text for word in words)), None)


def family_for(number, name):
    text = name.lower()
    if number == 15 or number >= 453 and number <= 456:
        return "target"
    if number >= 457:
        return "tax"
    if "purchase return" in text:
        return "purchase-return"
    if "purchase" in text or "supplier" in text or "reorder" in text or "buy" in text:
        return "purchase"
    if "transfer" in text or "reallocation" in text:
        return "transfer"
    if any(word in text for word in ("stock", "inventory", "overstock", "stockout", "assortment", "range ")):
        return "inventory"
    if "discount" in text or "price" in text or "markdown" in text:
        return "pricing"
    if "product" in text or "barcode" in text or "design" in text or "merchandise" in text:
        return "product"
    if "sales" in text or "profit" in text or "margin" in text or "gmroi" in text:
        return "sales"
    return "management"


def mode_for(number, name):
    text = name.lower()
    if 186 <= number <= 337 or any(word in text for word in ("forecast", "prediction", "probability", "recommendation", "risk")):
        return "predictive"
    if 338 <= number <= 415 or "alert" in text or "why " in text:
        return "diagnostic"
    return "descriptive"


def descriptions(name, category, family, mode):
    focus = name.replace("AI ", "").strip()
    return [
        f"Yeh report {focus} ko selected reporting period aur complete business scope mein dikhati hai.",
        "Amount aur quantity jahan relevant hon, dono live database detail records se calculate hotay hain.",
        "Branch, account, store aur product filters KPIs, charts aur detail rows sab par same apply hotay hain.",
        "Overall totals full selected scope ke hotay hain; Top-N rows sirf presentation aur ranking ke liye hoti hain.",
        f"Is ka business focus {category} hai aur analysis mode {mode} hai.",
        "Readable names master/reference tables se aatay hain, is liye raw codes ki jagah business-friendly labels miltay hain.",
        "Cherry AI live figures ko explain karke trend, risk, opportunity aur practical management action highlight karta hai.",
        "Is report ko review, comparison, planning aur timely decision-making ke liye use karein.",
    ]


def extract_reports(pdf_path):
    reader = PdfReader(str(pdf_path))
    lines = []
    for page in reader.pages[2:17]:
        lines.extend((page.extract_text() or "").splitlines())

    records = []
    current = None
    for raw_line in lines:
        line = re.sub(r"\s+", " ", raw_line).strip()
        match = re.match(r"^(\d{3})(?:\s+(.*))?$", line)
        if match:
            if current:
                records.append(current)
            current = {"number": int(match.group(1)), "parts": [match.group(2) or ""]}
        elif current:
            current["parts"].append(line)
    if current:
        records.append(current)

    reports = []
    for record in records:
        number = record["number"]
        parts = [part for part in record["parts"] if part]
        joined = " ".join(parts)
        if number <= 18:
            code_match = re.search(r"\b[A-Z][A-Z0-9_]+\b", joined)
            if not code_match:
                raise ValueError(f"No code found for report {number}")
            name = joined[:code_match.start()].strip()
            code = code_match.group(0)
        else:
            code_part_index = next((index for index, part in enumerate(parts) if "RPT_" in part), None)
            if code_part_index is None:
                raise ValueError(f"No catalog code found for report {number}")
            before = parts[:code_part_index]
            code_line = parts[code_part_index]
            code_start = code_line.index("RPT_")
            before.append(code_line[:code_start].strip())
            code_parts = [code_line[code_start:].strip()]
            for part in parts[code_part_index + 1:]:
                if re.fullmatch(r"[A-Z0-9_]+", part):
                    code_parts.append(part)
                else:
                    break
            name = " ".join(part for part in before if part).strip()
            code = "".join(code_parts)

        category = category_for(number)
        family = family_for(number, name)
        mode = mode_for(number, name)
        required = []
        if number in (15, 453):
            required = ["PosBranchIncentive"]
        elif number == 454:
            required = ["PosSalesmanIncentive"]
        elif number == 455:
            required = ["PosCategoryIncentive"]
        elif number == 456:
            required = ["PosCategoryWiseSalesmanIncentive"]
        reports.append({
            "id": number,
            "uiVariant": number,
            "code": code,
            "name": name,
            "category": category,
            "family": family,
            "mode": mode,
            "dimension": dimension_for(name),
            "chartType": "line" if any(word in name.lower() for word in ("daily", "weekly", "monthly", "trend", "forecast")) else "bar",
            "requiredTables": required,
            "descriptionLines": descriptions(name, category, family, mode),
        })

    if len(reports) != 460 or [item["id"] for item in reports] != list(range(1, 461)):
        raise ValueError("Catalog must contain stable report IDs 1 through 460")
    if len({item["code"] for item in reports}) != 460:
        raise ValueError("Catalog codes must be unique")
    return reports


def extract_workflow_catalog(workflow_path):
    text = Path(workflow_path).read_text(encoding="utf-8-sig")
    markers = list(re.finditer(r"(?m)^\[(\d{3})/460\]\s+(.+)$", text))
    if len(markers) != 460:
        raise ValueError(f"Expected 460 workflow definitions, found {len(markers)}")

    def field(block, label, default=""):
        match = re.search(rf"(?m)^{re.escape(label)}:\s*(.+)$", block)
        return match.group(1).strip() if match else default

    engine_families = {
        "PURCHASE":"purchase", "PURCHASE_RETURN":"purchase-return", "REORDER_AI":"purchase", "SUPPLIER_AI":"purchase",
        "TRANSFER":"transfer", "TRANSFER_AI":"transfer", "STOCK":"inventory", "INVENTORY_AI":"inventory",
        "STOCKOUT_AI":"inventory", "OVERSTOCK_AI":"inventory", "STOCK_PROFIT":"inventory",
        "PRICING_AI":"pricing", "DISCOUNT_POLICY":"pricing", "PRODUCT":"product", "PRODUCT_AI":"product",
        "FBR_GST":"tax", "TARGET_INCENTIVE":"target", "SALES":"sales", "FORECAST_SALES":"sales",
        "FORECAST_QTY":"sales", "PROFIT_AI":"sales", "MANAGEMENT18":"management", "MANAGEMENT_AI":"management",
    }
    reports = []
    for index, marker in enumerate(markers):
        number = int(marker.group(1));name = marker.group(2).strip()
        block = text[marker.end():markers[index + 1].start() if index + 1 < len(markers) else len(text)]
        code = field(block, "Code")
        category = field(block, "Category").title().replace("Ai ", "AI ").replace("Fbr", "FBR").replace("Gst", "GST").replace("Kpi", "KPI").replace("Vs", "vs")
        engine_line = re.search(r"(?m)^Engine:\s*([^|]+)\|\s*Dimension:\s*([^|]+)\|\s*Mode:\s*(.+)$", block)
        ui_line = re.search(r"(?m)^UI:\s*Variant\s*(\d+)\s*\|\s*Family\s*([^|]+)\|\s*Chart\s*(.+)$", block)
        if not engine_line or not ui_line:
            raise ValueError(f"Incomplete engine/UI definition for report {number}")
        source_engine, source_dimension, source_mode = (value.strip() for value in engine_line.groups())
        ui_variant, ui_family, chart_style = ui_line.groups()
        description_block = re.search(r"Description / How to Read:\s*(.*?)(?:\nUI requirement|\Z)", block, re.S)
        description_lines = []
        if description_block:
            description_lines = [re.sub(r"\s+", " ", value).strip() for _, value in re.findall(r"(?ms)^\s*([1-8])\.\s*(.*?)(?=^\s*[1-8]\.\s|\Z)", description_block.group(1))]
        if len(description_lines) != 8:
            description_lines = descriptions(name, category, family_for(number, name), mode_for(number, name))
        family = engine_families.get(source_engine, family_for(number, name))
        if source_engine in ("ACTUAL_AI", "ANOMALY_AI", "SCREEN360", "KPI"):
            family = family_for(number, name)
        lowered = source_dimension.lower().replace("catagory", "category")
        dimension = None if lowered in ("total", "none", "summary") else lowered
        predictive = source_engine in ("FORECAST_SALES","FORECAST_QTY","INVENTORY_AI","STOCKOUT_AI","OVERSTOCK_AI","REORDER_AI","TRANSFER_AI","PRICING_AI","PROFIT_AI","PRODUCT_AI","SUPPLIER_AI")
        diagnostic = source_engine in ("ANOMALY_AI","MANAGEMENT_AI")
        mode = "predictive" if predictive else "diagnostic" if diagnostic else "descriptive"
        metrics = [value.strip() for value in field(block, "Metrics").split("|") if value.strip()]
        metric_keys = [value.strip() for value in field(block, "Metric Keys").split("|") if value.strip()]
        required = []
        if code in ("ACTUAL_VS_TARGET", "RPT_25_001_BRANCH_TARGET_INCENTIVE"):
            required = ["PosBranchIncentive"]
        elif code == "RPT_25_002_SALESMAN_INCENTIVE": required = ["PosSalesmanIncentive"]
        elif code == "RPT_25_003_CATEGORY_INCENTIVE": required = ["PosCategoryIncentive"]
        elif code == "RPT_25_004_CATEGORY_SALESMAN_INCENTIVE": required = ["PosCategoryWiseSalesmanIncentive"]
        reports.append({
            "id": number, "uiVariant": int(ui_variant), "code": code, "name": name, "category": category,
            "family": family, "mode": mode, "dimension": dimension,
            "sourceEngine": source_engine, "sourceMode": source_mode, "uiFamily": ui_family.strip(),
            "chartStyle": chart_style.strip(), "chartType": "line" if re.search(r"trend|timeline|forecast", chart_style, re.I) else "pie" if re.search(r"pie|donut|mix", chart_style, re.I) else "bar",
            "metrics": metrics, "metricKeys": metric_keys, "needsAmountQuantityPair": field(block, "Needs Amount/Quantity Pair").lower() == "true",
            "dataRoute": field(block, "Data Route"), "analysisContract": field(block, "Data/Analysis Contract"),
            "advice": field(block, "Advice"), "requiredTables": required,
            "sourceDescriptionLines": description_lines,
            "descriptionLines": descriptions(name, category, family, mode),
        })
    if [item["id"] for item in reports] != list(range(1, 461)) or len({item["code"] for item in reports}) != 460 or len({item["uiVariant"] for item in reports}) != 460:
        raise ValueError("Workflow catalog IDs, codes and UI variants must each be unique 1 through 460")
    return reports


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "AI REPORTS WORK FLOW.txt"
    destination = Path(__file__).resolve().parents[1] / "ai" / "reportCatalog.generated.json"
    catalog = extract_workflow_catalog(source) if source.suffix.lower() == ".txt" else extract_reports(source)
    destination.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated 460 reports at {destination}")
