import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import PromptViewer, { EDIT_LOCKED_TEXT } from "./PromptViewer";
import { adminStatus, detail } from "./test-fixtures";
vi.mock("@/lib/prompts-api");

beforeEach(() => vi.resetAllMocks());

it("non-admin: registry text, chips, no toolbar, no override note when clean", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
  const { container } = render(<PromptViewer name="alpha_task_v2" admin={null} onChanged={() => {}} />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(await screen.findByText("Registry text for {title}")).toHaveClass("prompts-template");
  expect(screen.getByText("{title}")).toHaveClass("dev-chip");
  expect(screen.getByText("few-shot")).toHaveClass("dev-chip");
  expect(screen.getByText("Techniques")).toBeInTheDocument();
  expect(screen.getByText("Fills")).toBeInTheDocument();
  expect(container.querySelector(".prompts-toolbar")).toBeNull();
  expect(screen.queryByText(/local override of this prompt/)).toBeNull();
});
it("non-admin: override note when overridden, never override text; no placeholders copy", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ overridden: true, placeholders: [], override: "SECRET override text" }));
  render(<PromptViewer name="alpha_task_v2" admin={null} onChanged={() => {}} />);
  expect(await screen.findByText("This deployment runs a local override of this prompt. Its text is visible to admins only; below is the registry text.")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("SECRET override text");
  expect(screen.getByText("Registry text for {title}")).toBeInTheDocument();
  expect(screen.getByText("No placeholders")).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
});
it("admin: override text and full toolbar", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ overridden: true, override: "Override text" }));
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  expect(await screen.findByText("Override text")).toHaveClass("prompts-template");
  expect(screen.getByRole("button", { name: "Edit override" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compare with registry" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Reset to registry" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Compare with registry" }));
  expect(screen.getByText("− registry · + override")).toBeInTheDocument();
});
it("demo lock: Edit and Reset greyed out with the chart-kit tooltip and inert; Compare still works", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ overridden: true, override: "Override text" }));
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} editLocked />);
  const edit = await screen.findByRole("button", { name: "Edit override" });
  const reset = screen.getByRole("button", { name: "Reset to registry" });
  expect(edit).toHaveAttribute("aria-disabled", "true");
  expect(reset).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("button", { name: "Compare with registry" })).not.toHaveAttribute("aria-disabled");
  expect(edit).not.toHaveAttribute("title");
  expect(edit).toHaveAccessibleDescription(EDIT_LOCKED_TEXT);
  expect(reset).toHaveAccessibleDescription(EDIT_LOCKED_TEXT);
  fireEvent.mouseEnter(edit, { clientX: 40, clientY: 30 });
  expect(screen.getByRole("tooltip")).toHaveTextContent(EDIT_LOCKED_TEXT);
  fireEvent.mouseLeave(edit);
  expect(screen.queryByRole("tooltip")).toBeNull();
  await userEvent.click(edit);
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(reset);
  expect(screen.queryByText(/to the registry text\?/)).toBeNull();
  expect(api.resetPromptOverride).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Compare with registry" }));
  expect(screen.getByText("− registry · + override")).toBeInTheDocument();
});
it("admin: Edit override is not locked and shows no tooltip", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ override: null }));
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  const edit = await screen.findByRole("button", { name: "Edit override" });
  expect(edit).not.toHaveAttribute("aria-disabled");
  expect(edit).not.toHaveAccessibleDescription();
  fireEvent.mouseEnter(edit, { clientX: 40, clientY: 30 });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("admin without override: only Edit override", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ override: null }));
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  expect(await screen.findByText("Registry text for {title}")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Edit override" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Compare with registry" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reset to registry" })).toBeNull();
});
it("not configured and unreadable notes replace the toolbar", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
  const { container, unmount } = render(<PromptViewer name="alpha_task_v2" admin={adminStatus({ overrides: { configured: false, readable: true, count: 0 } })} onChanged={() => {}} />);
  expect(await screen.findByText("Editing is off: this API has no PROMPT_OVERRIDES_PATH. Set it to a file outside the repo to enable overrides.")).toBeInTheDocument();
  expect(container.querySelector(".prompts-toolbar")).toBeNull();
  unmount();
  const r = render(<PromptViewer name="alpha_task_v2" admin={adminStatus({ overrides: { configured: true, readable: false, count: 0 } })} onChanged={() => {}} />);
  expect(await screen.findByText("The override file can't be read, so LLM calls use the registry text. Fix or remove it on the server to edit overrides.")).toBeInTheDocument();
  expect(r.container.querySelector(".prompts-toolbar")).toBeNull();
});
it("reset confirm then result", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ overridden: true, override: "Override text" }));
  vi.mocked(api.resetPromptOverride).mockResolvedValue({ ...detail(), removed: true });
  const onChanged = vi.fn();
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={onChanged} />);
  await userEvent.click(await screen.findByRole("button", { name: "Reset to registry" }));
  expect(screen.getByText(/Reset alpha_task_v2 to the registry text\?/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(api.resetPromptOverride).toHaveBeenCalledWith("alpha_task_v2");
  expect(await screen.findByText("Reset alpha_task_v2 to the registry text.")).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalled();
});
it("reset failure", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail({ overridden: true, override: "Override text" }));
  vi.mocked(api.resetPromptOverride).mockRejectedValue(new Error("nope"));
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Reset to registry" }));
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reset (nope).");
});
it("detail error", async () => {
  vi.mocked(api.fetchPromptDetail).mockRejectedValue(new Error("boom"));
  render(<PromptViewer name="alpha_task_v2" admin={null} onChanged={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load alpha_task_v2 (boom).");
});
it("save refetches detail, reports missing placeholders, leaves edit mode", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
  vi.mocked(api.savePromptOverride).mockResolvedValue({ ...detail({ overridden: true }), cleared: false, missing_placeholders: ["content", "title"] });
  const onChanged = vi.fn();
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={onChanged} />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit override" }));
  await userEvent.type(screen.getByRole("textbox"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved override for alpha_task_v2.")).toBeInTheDocument();
  expect(screen.getByText("This override doesn't use: {content}, {title}.")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  await vi.waitFor(() => expect(api.fetchPromptDetail).toHaveBeenCalledTimes(2));
  expect(onChanged).toHaveBeenCalled();
});
it("toolbar is hidden while editing and returns after cancel", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit override" }));
  expect(screen.queryByRole("button", { name: "Edit override" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Edit override" })).toBeInTheDocument();
});
it("cleared save message", async () => {
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
  vi.mocked(api.savePromptOverride).mockResolvedValue({ ...detail(), cleared: true, missing_placeholders: [] });
  render(<PromptViewer name="alpha_task_v2" admin={adminStatus()} onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit override" }));
  await userEvent.type(screen.getByRole("textbox"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Matches the registry text; override cleared.")).toBeInTheDocument();
});
