import { fireEvent, screen } from "@testing-library/react";

/** Tool groups start collapsed: open every one that is on screen (their rows stay collapsed). */
export function openToolGroups(): void {
  for (const g of screen.queryAllByTestId("tool-group")) {
    const toggle = g.querySelector<HTMLButtonElement>(":scope > button");
    if (toggle && toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  }
}
