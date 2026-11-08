import "../components/usage/testMatchers";
import type { Skill } from "@agent-workstation/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ skills: vi.fn(), skill: vi.fn(), createSkill: vi.fn(), updateSkill: vi.fn(), deleteSkill: vi.fn(), invalidate: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, skills: mocks.skills, skill: mocks.skill, createSkill: mocks.createSkill, updateSkill: mocks.updateSkill, deleteSkill: mocks.deleteSkill } };
});
vi.mock("../lib/commands", () => ({ invalidateCommands: mocks.invalidate, loadCommands: vi.fn() }));

import { ApiError } from "../lib/api";
import { useApp } from "../store/app";
import { useToasts } from "../store/toasts";
import { makeZip } from "../test/makeZip";
import { TestRouter } from "../test/router";
import SkillEditorPage from "./SkillEditorPage";
import SkillsPage from "./SkillsPage";

const skill = (name: string, scope: Skill["scope"] = "user", description = `${name} description`): Skill => ({ name, description, scope, updatedAt: new Date(Date.now() - 3600_000).toISOString() });
const LIST: Skill[] = [skill("pdf-extract"), skill("summarize-notes"), skill("deploy-checklist", "global"), skill("release-notes", "global")];
const setAdmin = (isAdmin: boolean) => useApp.setState({ me: { user: { name: "u", isAdmin } } as never });

const renderApp = (path = "/skills") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Routes>
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/skills/:scope/:name" element={<SkillEditorPage />} />
      </Routes>
    </TestRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  setAdmin(false);
  mocks.skills.mockResolvedValue(LIST);
  mocks.createSkill.mockImplementation(async (b: { name: string; scope: Skill["scope"] }) => skill(b.name, b.scope));
  mocks.updateSkill.mockResolvedValue(skill("x"));
  mocks.deleteSkill.mockResolvedValue(undefined);
});

describe("SkillsPage list", () => {
  it("lists user and global skills in separate sections without explanatory copy", async () => {
    renderApp();
    const user = await screen.findByTestId("skills-user");
    const global = screen.getByTestId("skills-global");
    expect(within(user).getAllByTestId("skill-row").map((r) => r.dataset.name)).toEqual(["pdf-extract", "summarize-notes"]);
    expect(within(global).getAllByTestId("skill-row").map((r) => r.dataset.name)).toEqual(["deploy-checklist", "release-notes"]);
    expect(screen.queryByTestId("skills-palette-note")).toBeNull();
    expect(screen.queryByText(/Type \/ in a session/)).toBeNull();
    expect(within(user).getByText("/pdf-extract")).toBeInTheDocument();
    expect(within(user).getByText("pdf-extract description")).toBeInTheDocument();
  });

  it("non-admins can only view global skills; admins can create, upload, edit and delete them", async () => {
    const a = renderApp();
    const global = await screen.findByTestId("skills-global");
    expect(within(global).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(within(global).queryByTestId("skills-new-global")).toBeNull();
    expect(within(global).queryByTestId("skills-upload-global")).toBeNull();
    expect(within(global).getAllByRole("link", { name: "View" })).toHaveLength(2);
    expect(within(screen.getByTestId("skills-user")).getAllByRole("link", { name: "Edit" })).toHaveLength(2);
    a.unmount();

    setAdmin(true);
    renderApp();
    const g2 = await screen.findByTestId("skills-global");
    expect(within(g2).getByTestId("skills-new-global")).toBeInTheDocument();
    expect(within(g2).getByTestId("skills-upload-global")).toBeInTheDocument();
    expect(within(g2).getAllByRole("link", { name: "Edit" })).toHaveLength(2);
    expect(within(g2).getByRole("button", { name: "Delete release-notes" })).toBeInTheDocument();
  });

  it("an admin with no global skills still gets the section (to create the first one); others do not", async () => {
    mocks.skills.mockResolvedValue([skill("mine")]);
    const a = renderApp();
    await screen.findByTestId("skills-user");
    expect(screen.queryByTestId("skills-global")).toBeNull();
    a.unmount();
    setAdmin(true);
    renderApp();
    expect(await screen.findByTestId("skills-global")).toHaveTextContent("No global skills.");
  });

  it("degrades to 'Not available yet' on 501/404 and offers retry on other errors", async () => {
    mocks.skills.mockRejectedValueOnce(new ApiError(404, "not found: GET /api/skills"));
    const a = renderApp();
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-new-user")).toBeNull();
    a.unmount();

    mocks.skills.mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValueOnce(LIST);
    renderApp();
    expect(await screen.findByText("boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("skills-user");
  });
});

describe("SkillsPage create", () => {
  async function openCreate() {
    const u = userEvent.setup();
    renderApp();
    await screen.findByTestId("skills-user");
    await u.click(screen.getByTestId("skills-new-user"));
    return { u, input: await screen.findByLabelText("Name"), create: screen.getByTestId("skills-create") };
  }

  it("validates the name against [a-z0-9-] and refuses duplicates in the same scope", async () => {
    const { u, input, create } = await openCreate();
    expect(create).toBeDisabled();
    await u.type(input, "My Skill");
    expect(create).toBeDisabled();
    expect(screen.getByText("Use only a–z, 0–9 and - (max 64)")).toBeInTheDocument();
    await u.clear(input);
    await u.type(input, "pdf-extract");
    expect(create).toBeDisabled();
    expect(screen.getByText(/already exists in that scope/)).toBeInTheDocument();
    await u.clear(input);
    await u.type(input, "good-name-2");
    expect(create).toBeEnabled();
  });

  it("creates the skill from the SKILL.md template and opens it in the editor", async () => {
    const { u, input, create } = await openCreate();
    mocks.skill.mockResolvedValue({ ...skill("fresh-skill"), content: "---\nname: fresh-skill\n---\n" });
    await u.type(input, "fresh-skill");
    await u.click(create);
    expect(mocks.createSkill).toHaveBeenCalledTimes(1);
    const body = mocks.createSkill.mock.calls[0]![0] as { name: string; content: string; scope: string };
    expect(body).toMatchObject({ name: "fresh-skill", scope: "user" });
    expect(body.content).toMatch(/^---\nname: fresh-skill\ndescription: .+\n---\n/);
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(await screen.findByTestId("skill-editor")).toBeInTheDocument();
    expect(mocks.skill).toHaveBeenCalledWith("fresh-skill", "user");
  });

  it("shows the hub's refusal (409) inside the dialog", async () => {
    const { u, input, create } = await openCreate();
    mocks.createSkill.mockRejectedValue(new ApiError(409, "exists"));
    await u.type(input, "taken-elsewhere");
    await u.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
  });
});

describe("SkillsPage delete and upload", () => {
  it("deletes after a confirmation", async () => {
    const u = userEvent.setup();
    renderApp();
    await screen.findByTestId("skills-user");
    await u.click(screen.getByRole("button", { name: "Delete pdf-extract" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete skill pdf-extract?");
    expect(mocks.deleteSkill).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.deleteSkill).toHaveBeenCalledWith("pdf-extract", "user");
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  async function upload(files: File[], scope: "user" | "global" = "user") {
    const u = userEvent.setup();
    renderApp();
    await screen.findByTestId("skills-user");
    await u.click(screen.getByTestId(`skills-upload-${scope}`)); // opens the (hidden) picker; the change event below stands in for the choice
    await act(async () => {
      fireEvent.change(screen.getByTestId("skills-upload-input"), { target: { files } });
    });
  }
  const mdFile = (name: string, text: string) => new File([text], name, { type: "text/markdown" });

  it("imports a .md using the frontmatter name, falling back to the file name", async () => {
    await upload([mdFile("whatever.md", "---\nname: from-front\ndescription: d\n---\nbody"), mdFile("Release Notes.md", "no frontmatter")]);
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledTimes(2));
    expect(mocks.createSkill).toHaveBeenCalledWith({ name: "from-front", content: "---\nname: from-front\ndescription: d\n---\nbody", scope: "user" });
    expect(mocks.createSkill).toHaveBeenCalledWith({ name: "release-notes", content: "no frontmatter", scope: "user" });
    expect(mocks.skills).toHaveBeenCalledTimes(2); // list reloaded
    expect(useToasts.getState().toasts.filter((t) => t.title.startsWith("Imported"))).toHaveLength(2);
  });

  it("imports the SKILL.md of a .zip (also from a top-level folder) and says the other files were not imported", async () => {
    const skillMd = "---\nname: zipped\ndescription: from a zip\n---\nbody";
    const zip = new File([makeZip([{ name: "zipped/SKILL.md", text: skillMd, deflate: true }, { name: "zipped/scripts/run.sh", text: "echo hi" }, { name: "zipped/", text: "" }])], "zipped.zip", { type: "application/zip" });
    await upload([zip]);
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledWith({ name: "zipped", content: skillMd, scope: "user" }));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /Imported SKILL\.md only: 1 other file\(s\)/.test(t.title))).toBe(true));
  });

  it("reports a zip without SKILL.md", async () => {
    await upload([new File([makeZip([{ name: "README.md", text: "no skill here" }])], "empty.zip")]);
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => /empty\.zip.*no SKILL\.md/.test(t.title))).toBe(true));
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });

  it("rejects other file types and files without a usable name, and reports a name clash", async () => {
    mocks.createSkill.mockRejectedValueOnce(new ApiError(409, "exists"));
    await upload([new File(["x"], "notes.txt"), mdFile("###.md", "no name"), mdFile("dup.md", "x")]);
    await waitFor(() => expect(useToasts.getState().toasts.filter((t) => t.tone === "error")).toHaveLength(3));
    const titles = useToasts.getState().toasts.map((t) => t.title);
    expect(titles.some((t) => /notes\.txt.*only \.zip and \.md/.test(t))).toBe(true);
    expect(titles.some((t) => /###\.md.*no valid skill name/.test(t))).toBe(true);
    expect(titles.some((t) => /dup\.md.*already exists/.test(t))).toBe(true);
    expect(mocks.createSkill).toHaveBeenCalledTimes(1);
  });

  it("an admin's upload in the Global section creates a global skill", async () => {
    setAdmin(true);
    await upload([mdFile("shared.md", "---\nname: shared\n---\n")], "global");
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "shared", scope: "global" })));
  });
});

describe("SkillEditorPage", () => {
  const detail = (name: string, scope: Skill["scope"], content = "# hello\n") => ({ ...skill(name, scope), content });

  it("loads the SKILL.md, saves edits with the PUT body and clears the dirty marker", async () => {
    const u = userEvent.setup();
    mocks.skill.mockResolvedValue(detail("pdf-extract", "user"));
    renderApp("/skills/user/pdf-extract");
    const editor = await screen.findByTestId("skill-editor-content");
    expect(mocks.skill).toHaveBeenCalledWith("pdf-extract", "user");
    expect(editor).toHaveTextContent("# hello");
    const save = screen.getByTestId("skill-save");
    expect(save).toBeDisabled();

    await u.click(editor);
    await u.keyboard("more text");
    expect(await screen.findByTestId("skill-dirty")).toBeInTheDocument();
    expect(save).toBeEnabled();
    await u.click(save);
    await waitFor(() => expect(mocks.updateSkill).toHaveBeenCalledTimes(1));
    const [name, body] = mocks.updateSkill.mock.calls[0] as [string, { name: string; content: string; scope: string }];
    expect(name).toBe("pdf-extract");
    expect(body).toMatchObject({ name: "pdf-extract", scope: "user" });
    expect(body.content).toContain("more text");
    expect(body.content).toContain("# hello");
    await waitFor(() => expect(screen.queryByTestId("skill-dirty")).toBeNull());
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("⌘S saves", async () => {
    const u = userEvent.setup();
    mocks.skill.mockResolvedValue(detail("pdf-extract", "user"));
    renderApp("/skills/user/pdf-extract");
    const editor = await screen.findByTestId("skill-editor-content");
    await u.click(editor);
    await u.keyboard("x");
    await u.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(mocks.updateSkill).toHaveBeenCalled());
  });

  it("is read-only for a global skill unless the user is an admin", async () => {
    mocks.skill.mockResolvedValue(detail("deploy-checklist", "global"));
    const a = renderApp("/skills/global/deploy-checklist");
    const editor = await screen.findByTestId("skill-editor-content");
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByTestId("skill-save")).toBeNull();
    a.unmount();

    setAdmin(true);
    renderApp("/skills/global/deploy-checklist");
    expect(await screen.findByTestId("skill-editor-content")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByTestId("skill-save")).toBeInTheDocument();
  });

  it("shows a load error, and keeps the edits when saving fails", async () => {
    const u = userEvent.setup();
    mocks.skill.mockRejectedValueOnce(new ApiError(404, "skill not found", "not_found"));
    const a = renderApp("/skills/user/ghost");
    expect(await screen.findByText("skill not found")).toBeInTheDocument();
    a.unmount();

    mocks.skill.mockResolvedValue(detail("pdf-extract", "user"));
    mocks.updateSkill.mockRejectedValue(new ApiError(500, "disk full"));
    renderApp("/skills/user/pdf-extract");
    await u.click(await screen.findByTestId("skill-editor-content"));
    await u.keyboard("y");
    await u.click(screen.getByTestId("skill-save"));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.tone === "error" && t.title.includes("disk full"))).toBe(true));
    expect(screen.getByTestId("skill-dirty")).toBeInTheDocument();
  });
});
