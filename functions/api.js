export async function onRequest({ request, env }) {
  // Required env vars
  const NOTION_TOKEN = env.NOTION_TOKEN;
  const DASHBOARD_DB_ID = env.DASHBOARD_DB_ID;

  // Optional env vars (safe defaults)
  const CURRENCY_SYMBOL = env.CURRENCY_SYMBOL || "৳";
  const TITLE_PROPERTY = env.TITLE_PROPERTY || "Name";      // title column name in Finance Summary DB
  const TITLE_CONTAINS = env.TITLE_CONTAINS || "Dashboard"; // matches "Finance Dashboard"

  if (!NOTION_TOKEN || !DASHBOARD_DB_ID) {
    return json({ error: "Missing env vars: NOTION_TOKEN or DASHBOARD_DB_ID" }, 500);
  }

  // Query Finance Summary database to find the single row (title contains Dashboard)
  const queryBody = {
    filter: {
      property: TITLE_PROPERTY,
      title: { contains: TITLE_CONTAINS },
    },
    page_size: 1,
  };

  const qRes = await fetch(`https://api.notion.com/v1/databases/${DASHBOARD_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryBody),
  });

  if (!qRes.ok) {
    const body = await qRes.text();
    return json({ error: "Notion DB query failed", status: qRes.status, body }, 500);
  }

  const qData = await qRes.json();
  const page = qData.results?.[0];
  if (!page) {
    return json({ error: `No row found where ${TITLE_PROPERTY} contains "${TITLE_CONTAINS}"` }, 404);
  }

  const props = page.properties || {};

  // Supports Number and Formula(Number)
  function getNumber(name) {
    const p = props[name];
    if (!p) return 0;
    if (p.type === "number") return p.number ?? 0;
    if (p.type === "formula" && p.formula?.type === "number") return p.formula.number ?? 0;
    return 0;
  }

  const out = {
    currency: CURRENCY_SYMBOL,
    netWorth: getNumber("NET WORTH"),
    cashflow: getNumber("Cashflow (This Month)"),
    incoming: getNumber("Incoming (This Month)"),
    outgoing: getNumber("Outgoing (This Month)"),
    updatedAt: new Date().toISOString(),
  };

  return json(out, 200);

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}
