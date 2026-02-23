const API_BASE = 'http://localhost:8787';

export async function searchStocks(query) {
  try {
    const res = await fetch(`${API_BASE}/api/search?q=${query}`);
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function getChartData(symbol, interval = '15m', range = '5d') {
  try {
    const res = await fetch(`${API_BASE}/api/chart?symbol=${symbol}&interval=${interval}&range=${range}`);
    const data = await res.json();
    
    if (!data || !data.timestamp) return { chartData: [], meta: null };

    const timestamps = data.timestamp;
    const quotes = data.indicators.quote[0];

    // lightweight-chartsのフォーマットに整形し、不正なデータを除去してソート
    const formattedData = timestamps.map((time, index) => ({
      time: time,
      open: quotes.open[index],
      high: quotes.high[index],
      low: quotes.low[index],
      close: quotes.close[index],
    }))
    .filter(item => item.open !== null && item.high !== null && item.low !== null && item.close !== null)
    .sort((a, b) => a.time - b.time);

    // 時間の重複を排除
    const uniqueData = [];
    for (let i = 0; i < formattedData.length; i++) {
      if (i === 0 || formattedData[i].time !== formattedData[i - 1].time) {
        uniqueData.push(formattedData[i]);
      }
    }

    return { chartData: uniqueData, meta: data.meta };
  } catch (error) {
    console.error("Failed to fetch chart data", error);
    return { chartData: [], meta: null };
  }
}
