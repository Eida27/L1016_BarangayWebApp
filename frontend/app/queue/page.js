'use client';
import { useEffect, useState } from 'react';
export default function Queue() {
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/v1/queue-display', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        setQueue(await response.json());
        setError('');
      } catch {
        if (!controller.signal.aborted) setError('Queue unavailable. Please ask at the counter.');
      }
    }
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  return <main><p className="eyebrow">Barangay service counter</p><h1>Today’s queue</h1>
    {error ? <p role="alert">{error}</p> : <>
      <section className="card"><h2>Now serving</h2><p className="tickets">{queue.filter(q => q.state === 'serving').map(q => '#' + q.number).join(' · ') || '—'}</p></section>
      <section className="card"><h2>Waiting</h2><p>{queue.filter(q => q.state === 'waiting').map(q => '#' + q.number).join(' · ') || 'No tickets waiting'}</p></section>
    </>}
  </main>;
}
