export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // プリフライトリクエスト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. 銘柄検索API
      if (path === '/api/search') {
        const q = url.searchParams.get('q');
        const res = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${q}`);
        const data = await res.json();
        return new Response(JSON.stringify(data.quotes), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      // 2. チャートデータ取得API
      if (path === '/api/chart') {
        const symbol = url.searchParams.get('symbol');
        const interval = url.searchParams.get('interval') || '15m'; // 15分足
        const range = url.searchParams.get('range') || '5d';        // 過去5日分
        
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`);
        const data = await res.json();
        
        if (data.chart.error) {
           return new Response(JSON.stringify({ error: data.chart.error }), { status: 400, headers: corsHeaders });
        }
        
        return new Response(JSON.stringify(data.chart.result[0]), { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  }
};
