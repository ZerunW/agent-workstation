// Registers jest-dom matchers on the *running* vitest. The shared setup file imports
// "@testing-library/jest-dom/vitest", which resolves to the hoisted root vitest (a different copy than the
// one packages/web runs), so the matchers never reach this suite's `expect`.
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
