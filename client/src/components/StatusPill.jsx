const LABEL = {
  DISCONNECTED: 'Disconnected',
  STARTING: 'Launching browser…',
  WAITING_QR: 'Scan QR code',
  CONNECTED: 'Connected',
  ERROR: 'Error',
};

export default function StatusPill({ status, detail }) {
  return (
    <div className={`status status--${String(status).toLowerCase()}`}>
      <span className="status__dot" />
      <span>{LABEL[status] ?? status}</span>
      {detail ? <small title={detail}>{detail}</small> : null}
    </div>
  );
}
