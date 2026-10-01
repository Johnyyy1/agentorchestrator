'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div role="alert" className="system-error"><div><h1>This view could not load</h1><p>Check the local services and try again.</p><button className="button" onClick={reset}>Retry</button></div></div>;
}
