import { Suspense, lazy, useEffect, useState } from 'react';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const LiveStreamConnector = lazy(() => import('./pages/LiveStreamConnector'));

const getRouteFromPath = () => (window.location.pathname.startsWith('/live-stream') ? 'live-stream' : 'dashboard');

function App() {
  const [route, setRoute] = useState(getRouteFromPath);

  useEffect(() => {
    const handleLocationChange = () => setRoute(getRouteFromPath());

    window.addEventListener('popstate', handleLocationChange);

    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#8b8fa3', background: '#111214' }}>Loading workspace…</div>}>
      {route === 'dashboard' ? <Dashboard /> : <LiveStreamConnector />}
    </Suspense>
  );
}

export default App;