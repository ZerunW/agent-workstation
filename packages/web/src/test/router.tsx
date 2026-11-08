import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

/** MemoryRouter for tests (React Router 7: the former v7 future flags are the default). */
export function TestRouter({ children, initialEntries }: { children: ReactNode; initialEntries?: string[] }) {
  return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
}
