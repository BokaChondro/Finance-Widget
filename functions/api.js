export async function onRequest({ request, env }) {
  try {
    const { NOTION_TOKEN, SUMMARY_DB_ID, FLOW_DB_ID, DEBTS_DB_ID } = env;

    if (!NOTION_TOKEN || !SUMMARY_DB_ID || !FLOW_DB_ID || !DEBTS_DB_ID) {
      throw new Error("Missing Environment Variables. Did you add them in Cloudflare Settings?");
    }

    const headers = {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    };

    const today = new Date();
    const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
    const dateFilterStr = sixMonthsAgo.toISOString().split('T')[0];

    const[summaryRes, debtsRes, flowRes] = await Promise.all([
      fetch(`https://api.notion.com/v1/databases/${SUMMARY_DB_ID}/query`, {
        method: "POST", headers, body: JSON.stringify({ page_size: 1 })
      }),
      fetch(`https://api.notion.com/v1/databases/${DEBTS_DB_ID}/query`, {
        method: "POST", headers,
        body: JSON.stringify({
          filter: { property: "Paid", checkbox: { equals: false } },
          sorts: [{ property: "Repay Deadline", direction: "ascending" }],
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

    const summaryProps = summaryData.results[0]?.properties || {};
    const netWorth = getNum(summaryProps["NET WORTH"]);
    const balance = getNum(summaryProps["Savings Balance"]);
    const totalDebt = getNum(summaryProps["Debt Total (Unpaid)"]);

    const debts = debtsData.results.map(page => ({
      name: page.properties["Source"]?.title?.[0]?.plain_text || "Unknown",
      amount: getNum(page.properties["Taka"]),
      daysLeft: page.properties["Days Left"]?.formula?.string || "Unknown"
    }));

    const monthlyData = {}; 
    for(let i=0; i<=6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}`; 
      monthlyData[key] = { income: 0, expense: 0, label: d.toLocaleString('default', { month: 'short' }) };
    }

    flowData.results.forEach(page => {
      const dateStr = page.properties["Date"]?.date?.start;
      const type = page.properties["Type"]?.select?.name;
      const amount = getNum(page.properties["Taka"]);
      if(!dateStr || !type || !amount) return;

      const monthKey = dateStr.substring(0, 7); 
      if(monthlyData[monthKey]) {
        if(type === "Income") monthlyData[monthKey].income += amount;
        if(type === "Expense") monthlyData[monthKey].expense += amount;
      }
    });

    const sortedKeys = Object.keys(monthlyData).sort(); 
    const currentKey = sortedKeys.pop(); 
    const lastKey = sortedKeys[sortedKeys.length - 1]; 
    
    const current = monthlyData[currentKey];
    current.cashflow = current.income - current.expense;
    const last = monthlyData[lastKey];
    last.cashflow = last.income - last.expense;

    let sumInc = 0, sumExp = 0, sumFlow = 0;
    sortedKeys.forEach(k => {
      sumInc += monthlyData[k].income;
      sumExp += monthlyData[k].expense;
      sumFlow += (monthlyData[k].income - monthlyData[k].expense);
    });
    
    const avgInc = sumInc / 6;
    const avgExp = sumExp / 6;
    const avgFlow = sumFlow / 6;

    const fmt = (n) => "৳" + Math.abs(n).toLocaleString();
    
    const textInsights = {
      cashflow: current.cashflow >= 0 ?[
        `You saved a solid ${fmt(current.cashflow)} this month.`,
        `Awesome job! You're ${fmt(current.cashflow - avgFlow)} above your 6-month average.`,
        `The house wins. Bank balance grew nicely this round.`,
        `Kept ${fmt(Math.abs(current.cashflow - last.cashflow))} more in your pocket vs last month.`
      ] :[
        `Capital bleeding: You spent ${fmt(current.cashflow)} more than you earned.`,
        `Let's be careful—expenses outpaced income this round.`,
        `Missed your usual ${fmt(avgFlow)} savings average this time.`,
        `A tough hand this month, let's pull back next round.`
      ],
      income: current.income >= last.income ?[
        `Great month! You brought in ${fmt(current.income)}.`,
        `Earnings are up nicely compared to last month.`,
        `Secured ${fmt(current.income - avgInc)} more than your 6-month average.`,
        `Solid inflow velocity—keep the momentum going!`
      ] :[
        `You earned a total of ${fmt(current.income)} this month.`,
        `Income dropped slightly compared to last month.`,
        `A slower month for earnings, but you're still in the game.`,
        `Trailing your usual 6-month average by ${fmt(avgInc - current.income)}.`
      ],
      expense: current.expense >= last.expense ?[
        `High roller: You spent ${fmt(current.expense)} this month.`,
        `Outflows increased compared to last month.`,
        `You spent ${fmt(current.expense - avgExp)} more than your usual average.`,
        `Let's keep a closer eye on the spending chips next month.`
      ] :[
        `Great discipline! You only spent ${fmt(current.expense)}.`,
        `Successfully cut down expenses compared to last month.`,
        `Spending is well below your normal 6-month average.`,
        `Awesome job playing it safe and keeping outflows low.`
      ]
    };

    return new Response(JSON.stringify({
      summary: { netWorth, balance, totalDebt },
      kpis: { current, last, averages: { inc: avgInc, exp: avgExp, flow: avgFlow } },
      insights: textInsights,
      chartData: sortedKeys.map(k => monthlyData[k]),
      debts
    }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ backendError: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  function getNum(prop) {
    if (!prop) return 0;
    if (prop.type === "number") return prop.number || 0;
    if (prop.type === "formula") return prop.formula?.number || 0;
    return 0;
  }
}
