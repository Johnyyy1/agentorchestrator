'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, ArrowUpRight, Box, CircleHelp, Layers3, ListTodo, PanelTop } from 'lucide-react';
const items = [['/', 'Overview', PanelTop], ['/projects', 'Projects', Layers3], ['/tasks', 'Tasks', ListTodo], ['/decisions', 'Decisions', CircleHelp], ['/agents', 'Agents', Box], ['/activity', 'Activity', Activity]] as const;
export function Navigation() {
  const pathname = usePathname();
  return <>
    <nav aria-label="Main navigation">{items.map(([href, label, Icon]) => {
      const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
      return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={active ? 'nav-link selected' : 'nav-link'}><Icon size={17} strokeWidth={1.5} /><span>{label}</span>{active && <span className="nav-mark" />}</Link>;
    })}</nav>
    <div className="sidebar-foot"><span className="mono">LOCAL INSTANCE</span><p>Work stays on your machine.<br />You stay in control.</p><Link href="/agents">Inspect execution lanes <ArrowUpRight size={13} /></Link></div>
  </>;
}
