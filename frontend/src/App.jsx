import { Suspense, lazy } from 'react';

const Dashboard = lazy(() => import('./pages/Dashboard'));

function App() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#8b8fa3', background: '#111214' }}>Loading dashboard…</div>}>
      <Dashboard />
    </Suspense>
  );
}

export default App;