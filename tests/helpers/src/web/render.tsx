import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

// RTL render with provider wrapping. Today the wrapper is a passthrough
// because no global providers are mounted yet (React Query, Router,
// SupabaseProvider land in later sprints). Web tests use this from day
// 1 so the wrapper expansion is a one-place change.

// Future fields will land alongside the providers (tenantSlug, routerInitialEntries,
// queryClient). Keeping a type alias instead of an empty interface so eslint
// doesn't flag it; switch to interface + extends when there's a real field.
export type RenderWithProvidersOptions = Omit<RenderOptions, 'wrapper'>;

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
