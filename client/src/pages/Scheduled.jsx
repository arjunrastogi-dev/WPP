import { useCallback, useEffect, useState } from 'react';
import { api, socket } from '../api';
import { useSession } from '../SessionContext';
import Empty from '../components/Empty';

const STATUS_LABEL = {
  queued: 'Queued',
  sending: 'Sending',
  failed: 'Failed',
};

export default function ScheduledPage() {
  const { active } = useSession();
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!active) return;
    api.outbox(active).then(setJobs).catch((err) => setError(err.message));
  }, [active]);

  useEffect(() => { load(); }, [load]);

  // The queue drains in the background, so keep this view live.
  useEffect(() => {
    const onOutbox = ({ session }) => { if (session === active) load(); };
    socket.on('outbox', onOutbox);
    return () => socket.off('outbox', onOutbox);
  }, [active, load]);

  const cancel = async (job) => {
    await api.cancelJob(job.id).catch((err) => setError(err.message));
    load();
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Queue</h1>
        <p className="muted">
          Every outgoing message waits here. Sends are spaced a few seconds apart on purpose —
          firing them in a tight loop is what gets numbers banned.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {jobs.length === 0 ? (
        <Empty icon="🕒" title="Queue is empty"
          hint="Messages you send or schedule will appear here until they're delivered." />
      ) : (
        <table className="table">
          <thead>
            <tr><th>To</th><th>Message</th><th>Due</th><th>Status</th><th>Attempts</th><th /></tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.chat_id.split('@')[0]}</td>
                <td className="truncate">
                  {job.kind === 'media' ? `📎 ${job.media_name ?? 'file'} ` : ''}{job.body}
                </td>
                <td>
                  {new Date(job.send_at).toLocaleString()}
                  {job.send_at > Date.now() ? <em className="tag">scheduled</em> : null}
                </td>
                <td>
                  <span className={`jobstatus jobstatus--${job.status}`}>
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                  {job.last_error ? <small className="error" title={job.last_error}>{job.last_error}</small> : null}
                </td>
                <td>{job.attempts}</td>
                <td className="row-actions">
                  {job.status === 'queued'
                    ? <button className="danger" onClick={() => cancel(job)}>Cancel</button>
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
