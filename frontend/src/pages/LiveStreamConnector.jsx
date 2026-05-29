import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import toast, { Toaster } from 'react-hot-toast';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const T = {
    bg: '#111214',
    surface: '#18191d',
    raised: '#1e2026',
    border: '#2c2e36',
    borderHi: '#383a46',
    txt1: '#dde0e8',
    txt2: '#8b8fa3',
    txt3: '#555769',
    accent: '#5b6af0',
    ok: '#4a9e6e',
    okBg: '#0d1f16',
    okBdr: '#163028',
    high: '#4a8fd4',
    highBg: '#0d1a2a',
    highBdr: '#1a3050',
    crit: '#d97634',
    critBg: '#221a0f',
    critBdr: '#3d2a12',
};

const Card = ({ children, style }) => (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', ...style }}>
        {children}
    </div>
);

const PadCard = ({ children, style }) => (
    <Card style={{ padding: 18, ...style }}>
        {children}
    </Card>
);

const Divider = () => <div style={{ height: 1, background: T.border, margin: '8px 0' }} />;

const LiveStreamConnector = () => {
    const getPanelFromPath = () => {
        const path = window.location.pathname.toLowerCase();
        if (path.endsWith('/middleware')) return 'middleware';
        if (path.endsWith('/audit')) return 'audit';
        return 'stream';
    };
    const [activePanel, setActivePanel] = useState(getPanelFromPath);
    const [liveStreamSourceName, setLiveStreamSourceName] = useState('Browser Demo Feed');
    const [liveStreamEndpoint, setLiveStreamEndpoint] = useState('/api/live-events');
    const [liveStreamIntervalSeconds, setLiveStreamIntervalSeconds] = useState(5);
    const [liveStreamConnected, setLiveStreamConnected] = useState(false);
    const [liveStreamStatus, setLiveStreamStatus] = useState('Disconnected');
    const [auditEvents, setAuditEvents] = useState([]);
    const liveStreamInterval = useRef(null);
    const [middlewareOptions, setMiddlewareOptions] = useState({ normalizeIds: false, dropDuplicates: false });

    const buildDemoLiveBatch = () => {
        const now = new Date();
        return [
            {
                source_account: `LIVE-${Math.floor(Math.random() * 90000 + 10000)}`,
                destination_account: `LIVE-${Math.floor(Math.random() * 90000 + 10000)}`,
                amount: Number((Math.random() * 12500 + 500).toFixed(2)),
                timestamp: now.toISOString(),
                transaction_type: 'WIRE_TRANSFER',
                channel: 'webhook',
                F3924: Math.random() > 0.9 ? 1 : 0,
            },
            {
                source_account: `LIVE-${Math.floor(Math.random() * 90000 + 10000)}`,
                destination_account: `LIVE-${Math.floor(Math.random() * 90000 + 10000)}`,
                amount: Number((Math.random() * 12500 + 500).toFixed(2)),
                timestamp: now.toISOString(),
                transaction_type: 'CARD_NOT_PRESENT',
                channel: 'webhook',
                F3924: Math.random() > 0.92 ? 1 : 0,
            },
        ];
    };

    const postLiveBatch = async (events) => {
        // Apply client-side middleware transforms when testing from this console
        let outEvents = Array.isArray(events) ? [...events] : [];
        if (middlewareOptions.normalizeIds) {
            outEvents = outEvents.map(e => ({ ...e,
                source_account: String(e.source_account).toUpperCase(),
                destination_account: String(e.destination_account).toUpperCase(),
            }));
        }
        if (middlewareOptions.dropDuplicates) {
            const seen = new Set();
            outEvents = outEvents.filter(e => {
                const key = `${e.source_account}|${e.destination_account}|${e.timestamp}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        const response = await fetch(`${API_BASE}${liveStreamEndpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: outEvents }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || 'Failed to send live events');
        }

        return data;
    };

    const navigatePanel = (path, panel, replaceHistory = false) => {
        if (replaceHistory) {
            window.history.replaceState({}, '', path);
        } else {
            window.history.pushState({}, '', path);
        }
        setActivePanel(panel);
        window.dispatchEvent(new PopStateEvent('popstate'));
    };

    useEffect(() => {
        const syncPanel = () => setActivePanel(getPanelFromPath());
        window.addEventListener('popstate', syncPanel);
        return () => window.removeEventListener('popstate', syncPanel);
    }, []);

    useEffect(() => {
        const socket = io(API_BASE);
        const alarm = new Audio('/siren.mp3');

        socket.on('LIVE_STREAM_COMPLETE', (data) => {
            alarm.play().catch(() => {});
            setAuditEvents(prev => [
                {
                    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    label: data?.batchName || 'Live batch',
                    criticalCount: data?.criticalCount ?? 0,
                    highRiskCount: data?.highRiskCount ?? 0,
                    scanned: data?.scanned ?? 0,
                    at: new Date().toLocaleTimeString(),
                },
                ...prev,
            ].slice(0, 20));
        });

        return () => socket.disconnect();
    }, []);

    useEffect(() => () => {
        if (liveStreamInterval.current) {
            clearInterval(liveStreamInterval.current);
            liveStreamInterval.current = null;
        }
    }, []);

    const connectLiveStream = async () => {
        if (liveStreamConnected) return;

        try {
            setLiveStreamStatus('Connecting...');
            setLiveStreamConnected(true);
            setLiveStreamStatus(`Connected to ${liveStreamSourceName}`);

            if (liveStreamInterval.current) {
                clearInterval(liveStreamInterval.current);
            }

            liveStreamInterval.current = setInterval(async () => {
                try {
                    setLiveStreamStatus(`Streaming to ${liveStreamEndpoint}`);
                    await postLiveBatch(buildDemoLiveBatch());
                    setLiveStreamStatus(`Connected to ${liveStreamSourceName}`);
                } catch (error) {
                    setLiveStreamStatus(`Stream error: ${error.message}`);
                    toast.error(error.message, { style: { background: T.raised, color: T.crit, border: `1px solid ${T.critBdr}` } });
                }
            }, Math.max(3, Number(liveStreamIntervalSeconds) || 5) * 1000);

            toast.success('Live stream connected.', { style: { background: T.raised, color: T.ok, border: `1px solid ${T.okBdr}` } });
        } catch (error) {
            setLiveStreamConnected(false);
            setLiveStreamStatus('Disconnected');
            toast.error(error.message, { style: { background: T.raised, color: T.crit, border: `1px solid ${T.critBdr}` } });
        }
    };

    const disconnectLiveStream = () => {
        if (liveStreamInterval.current) {
            clearInterval(liveStreamInterval.current);
            liveStreamInterval.current = null;
        }
        setLiveStreamConnected(false);
        setLiveStreamStatus('Disconnected');
        toast.success('Live stream disconnected.', { style: { background: T.raised, color: T.ok, border: `1px solid ${T.okBdr}` } });
    };

    const sendDemoLiveBatch = async () => {
        try {
            setLiveStreamStatus('Sending demo batch...');
            await postLiveBatch(buildDemoLiveBatch());
            setLiveStreamStatus(liveStreamConnected ? `Connected to ${liveStreamSourceName}` : 'Disconnected');
        } catch (error) {
            setLiveStreamStatus(`Stream error: ${error.message}`);
            toast.error(error.message, { style: { background: T.raised, color: T.crit, border: `1px solid ${T.critBdr}` } });
        }
    };

    const sidebarButtonStyle = (active) => ({
        width: '100%',
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${active ? T.accent : T.borderHi}`,
        background: active ? T.accentBg : T.bg,
        color: active ? T.txt1 : T.txt2,
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        textAlign: 'left',
    });

    return (
        <div style={{ minHeight: '100vh', display: 'flex', background: `radial-gradient(circle at top, #1a1b22 0%, ${T.bg} 48%)`, color: T.txt1 }}>
            <Toaster position="top-right" />

            <aside style={{ width: 240, flexShrink: 0, borderRight: `1px solid ${T.border}`, background: T.surface, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                    <div style={{ fontSize: 11, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>Live Stream</div>
                    <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>Operations Hub</div>
                    <div style={{ fontSize: 12, color: T.txt2, marginTop: 8, lineHeight: 1.5 }}>
                        Keep the live console and the live audit log separate from the main dashboard.
                    </div>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                    <button onClick={() => navigatePanel('/live-stream', 'stream')} style={sidebarButtonStyle(activePanel === 'stream')}>
                        Current Live Stream
                    </button>
                    <button onClick={() => navigatePanel('/live-stream/audit', 'audit')} style={sidebarButtonStyle(activePanel === 'audit')}>
                        Live Audit Log
                    </button>
                    <button onClick={() => navigatePanel('/live-stream/middleware', 'middleware')} style={sidebarButtonStyle(activePanel === 'middleware')}>
                        Middleware
                    </button>
                </div>

                <div style={{ padding: 14, borderRadius: 10, background: T.bg, border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 10, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Connection</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: liveStreamConnected ? T.ok : T.txt1 }}>{liveStreamStatus}</div>
                </div>

                <div style={{ marginTop: 'auto', fontSize: 11, color: T.txt3, lineHeight: 1.5 }}>
                    The completion stream is now written into the audit view instead of stacking toast alerts.
                </div>
            </aside>

            <main style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
                    <div>
                        <div style={{ fontSize: 11, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>Live Stream Connector</div>
                        <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.03em' }}>
                            Dedicated live feed console
                        </h1>
                        <p style={{ margin: '8px 0 0', color: T.txt2, maxWidth: 700, lineHeight: 1.55 }}>
                            Use the stream tab to connect and send demo batches, or switch to the audit tab to review every live completion in one place.
                        </p>
                    </div>
                    <button
                        onClick={() => navigatePanel('/', 'stream', true)}
                        style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.surface, color: T.txt1, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                    >
                        Back to Dashboard
                    </button>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                    <button onClick={() => navigatePanel('/live-stream', 'stream')} style={{ padding: '8px 12px', borderRadius: 999, border: `1px solid ${activePanel === 'stream' ? T.accent : T.borderHi}`, background: activePanel === 'stream' ? T.accentBg : T.surface, color: activePanel === 'stream' ? T.txt1 : T.txt2, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        Current Live Stream
                    </button>
                    <button onClick={() => navigatePanel('/live-stream/audit', 'audit')} style={{ padding: '8px 12px', borderRadius: 999, border: `1px solid ${activePanel === 'audit' ? T.accent : T.borderHi}`, background: activePanel === 'audit' ? T.accentBg : T.surface, color: activePanel === 'audit' ? T.txt1 : T.txt2, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        Audit Log
                    </button>
                </div>

                {activePanel === 'stream' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(300px, 0.8fr)', gap: 16 }}>
                        <PadCard>
                            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 0.5fr', gap: 10, marginBottom: 12 }}>
                                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span style={{ fontSize: 10, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Source Name</span>
                                    <input
                                        value={liveStreamSourceName}
                                        onChange={e => setLiveStreamSourceName(e.target.value)}
                                        placeholder="Browser Demo Feed"
                                        style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.raised, color: T.txt1, outline: 'none' }}
                                    />
                                </label>
                                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span style={{ fontSize: 10, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Backend Endpoint</span>
                                    <input
                                        value={liveStreamEndpoint}
                                        onChange={e => setLiveStreamEndpoint(e.target.value)}
                                        placeholder="/api/live-events"
                                        style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.raised, color: T.txt1, outline: 'none', fontFamily: 'monospace' }}
                                    />
                                </label>
                                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span style={{ fontSize: 10, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Interval (sec)</span>
                                    <input
                                        type="number"
                                        min="3"
                                        max="60"
                                        value={liveStreamIntervalSeconds}
                                        onChange={e => setLiveStreamIntervalSeconds(e.target.value)}
                                        style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.raised, color: T.txt1, outline: 'none' }}
                                    />
                                </label>
                            </div>

                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                <button
                                    onClick={connectLiveStream}
                                    disabled={liveStreamConnected}
                                    style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${T.accent}`, background: liveStreamConnected ? T.raised : T.accent, color: liveStreamConnected ? T.txt3 : '#fff', fontSize: 12, fontWeight: 700, cursor: liveStreamConnected ? 'not-allowed' : 'pointer' }}
                                >
                                    Connect Live Stream
                                </button>
                                <button
                                    onClick={sendDemoLiveBatch}
                                    style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.surface, color: T.txt1, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                                >
                                    Send Demo Batch
                                </button>
                                <button
                                    onClick={disconnectLiveStream}
                                    disabled={!liveStreamConnected}
                                    style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: !liveStreamConnected ? T.bg : T.raised, color: !liveStreamConnected ? T.txt3 : T.txt1, fontSize: 12, fontWeight: 700, cursor: !liveStreamConnected ? 'not-allowed' : 'pointer' }}
                                >
                                    Disconnect
                                </button>
                            </div>
                        </PadCard>

                        <div style={{ display: 'grid', gap: 16 }}>
                            <Card style={{ padding: 18, background: `linear-gradient(135deg, ${T.raised} 0%, #17191f 100%)`, border: `1px solid ${T.borderHi}` }}>
                                <div style={{ fontSize: 10, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Connection</div>
                                <div style={{ fontSize: 20, fontWeight: 700, color: liveStreamConnected ? T.ok : T.txt1 }}>{liveStreamStatus}</div>
                                <div style={{ marginTop: 8, fontSize: 12, color: T.txt2, lineHeight: 1.5 }}>
                                    Live batches are POSTed to the backend micro-batcher and then scored by the ML service.
                                </div>
                            </Card>

                            <PadCard>
                                <div style={{ fontSize: 11, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Recent Audit Events</div>
                                {auditEvents.length === 0 ? (
                                    <div style={{ fontSize: 12, color: T.txt2, lineHeight: 1.6 }}>
                                        No live batches completed yet. Switch to the audit tab after sending a demo batch or connecting the interval stream.
                                    </div>
                                ) : (
                                    <div style={{ display: 'grid', gap: 10 }}>
                                        {auditEvents.slice(0, 4).map(event => (
                                            <div key={event.id} style={{ padding: 12, borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                                                    <div style={{ fontSize: 12, fontWeight: 700, color: T.txt1 }}>{event.label}</div>
                                                    <div style={{ fontSize: 11, color: T.txt3, fontFamily: 'monospace' }}>{event.at}</div>
                                                </div>
                                                <div style={{ fontSize: 12, color: T.txt2 }}>
                                                    {event.scanned} scanned · {event.criticalCount} critical · {event.highRiskCount} high risk
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </PadCard>
                        </div>
                    </div>
                ) : activePanel === 'audit' ? (
                    <PadCard>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
                            <div>
                                <div style={{ fontSize: 11, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Audit Log</div>
                                <div style={{ fontSize: 18, fontWeight: 700, color: T.txt1 }}>Completed live batches</div>
                                <div style={{ fontSize: 12, color: T.txt2, marginTop: 6, lineHeight: 1.5 }}>
                                    This log keeps the live completions readable without stacking popup alerts on the screen.
                                </div>
                            </div>
                            <button
                                onClick={() => navigatePanel('/live-stream', 'stream')}
                                style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: T.surface, color: T.txt1, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                            >
                                Back to Live Stream
                            </button>
                        </div>

                        {auditEvents.length === 0 ? (
                            <div style={{ padding: 18, borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`, color: T.txt2, fontSize: 12 }}>
                                No live audit entries yet.
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: 10 }}>
                                {auditEvents.map(event => (
                                    <div key={event.id} style={{ padding: 14, borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
                                            <div style={{ fontSize: 13, fontWeight: 700, color: T.txt1 }}>{event.label}</div>
                                            <div style={{ fontSize: 11, color: T.txt3, fontFamily: 'monospace' }}>{event.at}</div>
                                        </div>
                                        <div style={{ fontSize: 12, color: T.txt2 }}>
                                            {event.scanned} scanned · {event.criticalCount} critical · {event.highRiskCount} high risk
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </PadCard>
                ) : activePanel === 'middleware' ? (
                    <PadCard>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
                            <div>
                                <div style={{ fontSize: 11, color: T.txt3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Middleware</div>
                                <div style={{ fontSize: 18, fontWeight: 700, color: T.txt1 }}>Live Stream Middleware</div>
                                <div style={{ fontSize: 12, color: T.txt2, marginTop: 6, lineHeight: 1.5 }}>
                                    Toggle middleware hooks that run during live batch processing. These controls normalize demo payloads and trim duplicate test events before they are sent to the backend.
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <button onClick={() => setMiddlewareOptions(o => ({ ...o, normalizeIds: !o.normalizeIds }))} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: middlewareOptions?.normalizeIds ? T.accent : T.surface, color: middlewareOptions?.normalizeIds ? T.txt1 : T.txt2 }}>Normalize IDs</button>
                                <button onClick={() => setMiddlewareOptions(o => ({ ...o, dropDuplicates: !o.dropDuplicates }))} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.borderHi}`, background: middlewareOptions?.dropDuplicates ? T.accent : T.surface, color: middlewareOptions?.dropDuplicates ? T.txt1 : T.txt2 }}>Drop Duplicates</button>
                            </div>
                        </div>
                        <Divider />
                        <div style={{ padding: 12, color: T.txt2 }}>
                            <p style={{ margin: 0 }}>Current middleware settings are client-side only and affect demo batches sent from this console.</p>
                        </div>
                    </PadCard>
                ) : null}
            </main>
        </div>
    );
};

export default LiveStreamConnector;
