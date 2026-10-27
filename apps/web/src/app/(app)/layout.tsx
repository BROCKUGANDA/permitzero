import { AppShell } from '@/components/shell';

export default function AppGroupLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <AppShell>{children}</AppShell>;
}
