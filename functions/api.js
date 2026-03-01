export async function onRequest({ request, env }) {
  try {
    const { NOTION_TOKEN, SUMMARY_DB_ID, FLOW_DB_ID, DEBTS_DB_ID } = env;

    if (!NOTION_TOKEN || !SUMMARY_DB_ID || !FLOW_DB_ID || !DEBTS_DB_ID) {
      throw new Error("Missing Environment Variables.");
    }

    const headers = {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    };

    // Calculate 13 months ago for the Chart Data
    const today = new Date();
    const thirteenMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 12, 1);
    const dateFilterStr = thirteenMonthsAgo.toISOString().split('T')[0];

    const [summaryRes, debtsRes, flowRes] = await Promise.all([
      fetch(`https://api.notion.com/v1/databases/${SUMMARY_DB_ID}/query`, {
        method: "POST", headers, body: JSON.stringify({ page_size: 1 })
      }),
      fetch(`https://api.notion.com/v1/databases/${DEBTS_DB_ID}/query`, {
        method: "POST", headers,
        body: JSON.stringify({
          filter: { property: "Paid", checkbox: { equals: false } },
          sorts:[{ property: "Repay Deadline", direction: "ascending" }],
          page_size: 5
        })
      }),
      fetch(`https://api.notion.com/v1/databases/${FLOW_DB_ID}/query`, {
        method: "POST", headers,
        body: JSON.stringify({
          filter: { property: "Date", date: { on_or_after: dateFilterStr } }
        })
      })
    ]);

    if (!summaryRes.ok) throw new Error(`Summary DB: ${await summaryRes.text()}`);
    if (!debtsRes.ok) throw new Error(`Debts DB: ${await debtsRes.text()}`);
    if (!flowRes.ok) throw new Error(`Flow DB: ${await flowRes.text()}`);

    const summaryData = await summaryRes.json();
    const debtsData = await debtsRes.json();
    const flowData = await flowRes.json();

    // Safely extract properties (handles Numbers, Formulas, and Rollups)
    const getNum = (prop) => {
      if (!prop) return 0;
      if (prop.type === "number") return prop.number || 0;
      if (prop.type === "formula") return prop.formula?.number || 0;
      if (prop.type === "rollup") return prop.rollup?.number || 0;
      return 0;
    };

    const summaryProps = summaryData.results[0]?.properties || {};

    // 1. Core Summary Stats
    const netWorth = getNum(summaryProps["NET WORTH"]);
    const balance = getNum(summaryProps["Savings Balance"]);
    const totalDebt = getNum(summaryProps["Debt Total (Unpaid)"]);

    // 2. Exact Card Data (Pulled directly from your new Notion Rollups)
    const kpis = {
      current: {
        income: getNum(summaryProps["Sum Inc (1-30)"]),
        expense: getNum(summaryProps["Sum Exp (1-30)"]),
        cashflow: getNum(summaryProps["CF (1-30)"])
      },
      last: {
        income: getNum(summaryProps["Sum Inc (31-60)"]),
        expense: getNum(summaryProps["Sum Exp (31-60)"]),
        cashflow: getNum(summaryProps["CF (31-60)"])
      },
      averages: {
        inc: getNum(summaryProps["Sum Inc (31-210)"]) / 6,
        exp: getNum(summaryProps["Sum Exp (31-210)"]) / 6,
        flow: getNum(summaryProps["CF (31-210)"]) / 6
      }
    };

    // 3. Outstanding Debts
    const debts = debtsData.results.map(page => ({
      name: page.properties["Source"]?.title?.[0]?.plain_text || "Unknown",
      amount: getNum(page.properties["Taka"]),
      daysLeft: page.properties["Days Left"]?.formula?.string || "Unknown"
    }));

    // 4. Group Flow Data for the 13-Month Chart (Extremely Fast Operation)
    const monthlyData = {}; 
    for(let i = 0; i <= 12; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}`; 
      monthlyData[key] = { income: 0, expense: 0, label: d.toLocaleString('default', { month: 'short' }) };
    }

    flowData.results.forEach(page => {
      const dateStr = page.properties["Date"]?.date?.start;
      const type = page.properties["Type"]?.select?.name;
      const amount = getNum(page.properties["Taka"]); // Handles regular number or signed number
      
      if(!dateStr || !type || !amount) return;

      const monthKey = dateStr.substring(0, 7); // Extracts 'YYYY-MM'
      if(monthlyData[monthKey]) {
        if(type === "Income") monthlyData[monthKey].income += Math.abs(amount);
        if(type === "Expense") monthlyData[monthKey].expense += Math.abs(amount);
      }
    });

    const sortedKeys = Object.keys(monthlyData).sort(); 
    const chartData = sortedKeys.map(k => {
      const d = monthlyData[k];
      d.cashflow = d.income - d.expense;
      return d;
    });

    return new Response(JSON.stringify({
      summary: { netWorth, balance, totalDebt },
      kpis,
      chartData,
      debts
    }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ backendError: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
