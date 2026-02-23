import React, { useState, useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';
import { searchStocks, getChartData } from './api';
import './styles.css';

// 移動平均線(SMA)を計算する関数
function calculateSMA(data, period) {
  const smaData = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((acc, val) => acc + val.close, 0);
    smaData.push({ time: data[i].time, value: sum / period });
  }
  return smaData;
}

function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  
  // LocalStorageからポートフォリオを復元
  const [portfolio, setPortfolio] = useState(() => {
    const saved = localStorage.getItem('portfolio');
    return saved ? JSON.parse(saved) : [{ symbol: 'AAPL', name: 'Apple Inc.' }];
  });
  
  const [selectedStock, setSelectedStock] = useState(portfolio[0] || null);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [priceChange, setPriceChange] = useState(0);
  const [priceChangePercent, setPriceChangePercent] = useState(0);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);

  // ポートフォリオ変更時にLocalStorageへ自動保存
  useEffect(() => {
    localStorage.setItem('portfolio', JSON.stringify(portfolio));
  }, [portfolio]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query) return;
    const res = await searchStocks(query);
    // 株とETFのみ抽出して表示
    if (Array.isArray(res)) {
      setResults(res.filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF' || r.quoteType === 'INDEX'));
    }
  };

  const addToPortfolio = (stock) => {
    if (!portfolio.find(p => p.symbol === stock.symbol)) {
      const newStock = { symbol: stock.symbol, name: stock.shortname || stock.longname };
      setPortfolio([...portfolio, newStock]);
      setSelectedStock(newStock); // 追加したらその銘柄を選択状態にする
    }
    setResults([]);
    setQuery('');
  };

  const removeFromPortfolio = (e, symbol) => {
    e.stopPropagation();
    const newPortfolio = portfolio.filter(p => p.symbol !== symbol);
    setPortfolio(newPortfolio);
    if (selectedStock?.symbol === symbol) {
      setSelectedStock(newPortfolio.length > 0 ? newPortfolio[0] : null);
    }
  };

  // チャートの初期化・描画とリアルタイム更新
  useEffect(() => {
    if (!selectedStock || !chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: 'solid', color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#2B2B43' }, horzLines: { color: '#2B2B43' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2B2B43' },
      timeScale: { borderColor: '#2B2B43', timeVisible: true },
    });
    chartRef.current = chart;

    // ローソク足
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });

    // 移動平均線群（画像に沿って複数表示）
    const sma25 = chart.addLineSeries({ color: '#f5cb5c', lineWidth: 1.5, crosshairMarkerVisible: false, title: 'SMA 25' });
    const sma50 = chart.addLineSeries({ color: '#2962FF', lineWidth: 1.5, crosshairMarkerVisible: false, title: 'SMA 50' });
    const sma75 = chart.addLineSeries({ color: '#FF6D00', lineWidth: 1.5, crosshairMarkerVisible: false, title: 'SMA 75' });

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight
        });
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    let intervalId;
    let isMounted = true;

    const loadData = async () => {
      const { chartData, meta } = await getChartData(selectedStock.symbol, '15m', '5d');
      if (isMounted && chartData.length > 0) {
        candleSeries.setData(chartData);
        sma25.setData(calculateSMA(chartData, 25));
        sma50.setData(calculateSMA(chartData, 50));
        sma75.setData(calculateSMA(chartData, 75));

        const price = meta?.regularMarketPrice || chartData[chartData.length - 1].close;
        const prevClose = meta?.chartPreviousClose || chartData[0].close;
        
        setCurrentPrice(price);
        setPriceChange(price - prevClose);
        setPriceChangePercent(((price - prevClose) / prevClose) * 100);
        
        chart.timeScale().fitContent();
      }
    };

    loadData();

    // 10秒に1回、最新データを取得してリアルタイム更新（ポーリング）
    intervalId = setInterval(async () => {
      const { chartData, meta } = await getChartData(selectedStock.symbol, '15m', '5d');
      if (isMounted && chartData.length > 0) {
        const latest = chartData[chartData.length - 1];
        candleSeries.update(latest); // 追加分のデータのみ滑らかに更新
        
        const price = meta?.regularMarketPrice || latest.close;
        const prevClose = meta?.chartPreviousClose || chartData[0].close;
        setCurrentPrice(price);
        setPriceChange(price - prevClose);
        setPriceChangePercent(((price - prevClose) / prevClose) * 100);
      }
    }, 10000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      window.removeEventListener('resize', handleResize);
      chart.remove(); // React18のStrict Modeによる多重描画を防止
      chartRef.current = null;
    };
  }, [selectedStock]);

  return (
    <div className="app-container">
      {/* 左サイドバー: 検索とポートフォリオ */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>ポートフォリオ管理</h2>
        </div>
        
        <form onSubmit={handleSearch} className="search-box">
          <input 
            type="text" placeholder="銘柄検索 (例: AAPL, 7203.T)" 
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">検索</button>
        </form>

        {results.length > 0 && (
          <ul className="search-results">
            {results.map(r => (
              <li key={r.symbol} onClick={() => addToPortfolio(r)}>
                <div className="res-info">
                  <strong>{r.symbol}</strong>
                  <span className="stock-name">{r.shortname || r.longname}</span>
                </div>
                <span className="add-icon">+</span>
              </li>
            ))}
          </ul>
        )}

        <div className="portfolio-section">
          <h3>登録済み銘柄</h3>
          <ul className="portfolio-list">
            {portfolio.map(p => (
              <li 
                key={p.symbol} 
                className={selectedStock?.symbol === p.symbol ? 'active' : ''}
                onClick={() => setSelectedStock(p)}
              >
                <div className="port-info">
                  <strong>{p.symbol}</strong>
                  <span>{p.name}</span>
                </div>
                <button onClick={(e) => removeFromPortfolio(e, p.symbol)} className="del-btn">✕</button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 右メインエリア: チャートとリアルタイム価格 */}
      <div className="main-content">
        {selectedStock ? (
          <div className="chart-wrapper">
            <div className="chart-header">
              <div className="stock-title">
                <h1>{selectedStock.name}</h1>
                <span className="ticker">{selectedStock.symbol}</span>
              </div>
              <div className="price-info">
                <span className={`current-price ${priceChange >= 0 ? 'up' : 'down'}`}>
                  {currentPrice ? currentPrice.toFixed(4) : '---'}
                </span>
                <span className={`price-change ${priceChange >= 0 ? 'up' : 'down'}`}>
                  {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(4)} ({priceChange >= 0 ? '+' : ''}{priceChangePercent.toFixed(2)}%)
                  <span className="live-badge">● リアルタイム</span>
                </span>
              </div>
            </div>
            <div ref={chartContainerRef} className="chart-container" />
          </div>
        ) : (
          <div className="empty-state">
            <p>左側のメニューから銘柄を検索し、ポートフォリオに追加してください。</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
