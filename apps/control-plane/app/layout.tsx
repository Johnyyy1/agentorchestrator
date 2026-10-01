import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Navigation } from '../components/navigation.js';
import { SystemStatus } from '../components/live.js';
import { fixtureMode } from '../lib/server.js';
import './globals.css';
export const metadata: Metadata = { title: { default: 'Jonas OS · Control Plane', template: '%s · Jonas OS' }, description: 'Local operator interface for Jonas OS.' };
export const dynamic = 'force-dynamic';
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><a href="#main" className="skip-link">Skip to content</a><div className="app-shell"><aside className="sidebar"><Link href="/" className="brand" aria-label="Jonas OS overview"><span className="brand-symbol" aria-hidden="true"><i /><i /><i /><i /></span><span>JONAS<span className="brand-os"> OS</span></span></Link><div className="sidebar-caption mono">CONTROL PLANE / V1</div><Navigation /></aside><div className="workspace"><header className="topbar"><span className="mono">ENGINE / LOCAL</span><SystemStatus /></header>{fixtureMode() && <div className="fixture-banner">DEVELOPMENT FIXTURES · Simulated data and actions · no database writes or inference</div>}<main id="main" className="main-content">{children}</main><footer className="workspace-footer"><span className="mono">JONAS OS</span><span>Local orchestration. Human direction.</span></footer></div></div></body></html>;
}
