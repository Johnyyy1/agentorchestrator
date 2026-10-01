import Link from 'next/link';
export default function NotFound() { return <div className="empty-page"><span className="eyebrow">404 / NOT FOUND</span><h1>This record is not available.</h1><p>The ID may be invalid or the record may have been removed.</p><Link href="/tasks" className="button">Browse tasks</Link></div>; }
