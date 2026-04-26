import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

// RTL render with provider wrapping. Today the wrapper is a passthrough
// because no global providers are mounted yet (React Query, Router,
// SupabaseProvider land in later sprints). Web tests use this from day
// 1 so the wrapper expansion is a one-place change.

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  // Future: tenantSlug?: string; routerInitialEntries?: string[]; queryClient?: QueryClient
}

function AllProviders({ children }: { children: ReactNode }) {
  // FHS-152 + later: QueryClientProvider, MemoryRouter, ThemeProvider, etc.
  return <>{children}</>;
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult {
  return render(ui, { wrapper: AllProviders, ...options });
}
