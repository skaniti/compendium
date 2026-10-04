import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import { EVALS_LOCKED_TEXT } from "./EvalHistory";
import PromptsView, { PROMPTS_SUBTITLE, STALE_TEXT } from "./PromptsView";
import { adminStatus, detail, modelRow, summary } from "./test-fixtures";

const session = vi.hoisted(() => ({ value: { role: "admin", actingAsDemo: false, status: "hydrated" } as Record<string, unknown> }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => session.value }));
vi.mock("@/lib/prompts-api");

beforeEach(() => {
  vi.resetAllMocks();
  session.value = { role: "admin", actingAsDemo: false, status: "hydrated" };
  vi.mocked(api.fetchPromptDetail).mockImplementation(async (name: string) => detail({ name, override: null }));
});

it("loading, subtitle, models before registry", async () => {
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary());
  const { container } = render(<PromptsView />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector(".prompts-models")).toBeTruthy());
  expect(screen.getByText(PROMPTS_SUBTITLE)).toBeInTheDocument();
  const a = container.querySelector(".prompts-models") as HTMLElement;
  const b = container.querySelector(".prompts-registry") as HTMLElement;
  expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("stale API", async () => {
  vi.mocked(api.fetchPromptsSummary).mockRejectedValue(new Error(STALE_API_MESSAGE));
  const { container } = render(<PromptsView />);
  expect(await screen.findByRole("alert")).toHaveTextContent(STALE_TEXT);
  expect(container.querySelector(".prompts-models")).toBeNull();
});
it("other error", async () => {
  vi.mocked(api.fetchPromptsSummary).mockRejectedValue(new Error("boom"));
  render(<PromptsView />);
  expect(await screen.findByText("Couldn't load prompts (boom).")).toHaveAttribute("role", "alert");
});
it("plain demo: the admin sections stay, greyed out, and no runs are fetched", async () => {
  session.value = { role: "demo", actingAsDemo: false, status: "hydrated" };
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ admin: null }));
  const { container } = render(<PromptsView />);
  await screen.findByText("Registry text for {title}");
  expect(container.querySelector(".prompts-evals")).toHaveTextContent(EVALS_LOCKED_TEXT);
  expect(screen.getByRole("button", { name: "Edit override" })).toHaveAttribute("aria-disabled", "true");
  expect(api.fetchEvalRuns).not.toHaveBeenCalled();
});
it("a regular user sees neither the admin sections nor their placeholders", async () => {
  session.value = { role: "user", actingAsDemo: false, status: "hydrated" };
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ admin: null }));
  const { container } = render(<PromptsView />);
  await screen.findByText("Registry text for {title}");
  expect(container.querySelector(".prompts-evals")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit override" })).toBeNull();
});
it("admin session with admin block shows evals", async () => {
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ admin: adminStatus() }));
  const { container } = render(<PromptsView />);
  await waitFor(() => expect(container.querySelector(".prompts-evals")).toBeTruthy());
  expect(await screen.findByRole("button", { name: "Edit override" })).not.toHaveAttribute("aria-disabled");
});
it.each([false, true])("R20: a demo session (acting %s) handed an admin block still gets the plain-demo view", async (acting) => {
  session.value = { role: "demo", actingAsDemo: acting, status: "hydrated" };
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ admin: adminStatus() }));
  const { container } = render(<PromptsView />);
  await screen.findByText("Registry text for {title}");
  expect(container.querySelector(".prompts-evals")).toHaveTextContent(EVALS_LOCKED_TEXT);
  const edit = screen.getByRole("button", { name: "Edit override" });
  expect(edit).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(edit);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(api.fetchEvalRuns).not.toHaveBeenCalled();
});
it("models prompt button selects that prompt", async () => {
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ models: [modelRow({ prompt: "beta_task_v1" })] }));
  render(<PromptsView />);
  await screen.findByText("Registry text for {title}");
  await userEvent.click(within(document.querySelector(".prompts-models-table") as HTMLElement).getByRole("button", { name: "beta_task_v1" }));
  await waitFor(() => expect(api.fetchPromptDetail).toHaveBeenCalledWith("beta_task_v1"));
  const pressed = screen.getAllByRole("button", { pressed: true });
  expect(pressed.some((b) => b.getAttribute("title") === "beta_task_v1")).toBe(true);
});
it("save refreshes the summary", async () => {
  vi.mocked(api.fetchPromptsSummary).mockResolvedValue(summary({ admin: adminStatus() }));
  vi.mocked(api.savePromptOverride).mockResolvedValue({ ...detail({ overridden: true }), cleared: false, missing_placeholders: [] });
  render(<PromptsView />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit override" }));
  await userEvent.type(screen.getByRole("textbox"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.fetchPromptsSummary).toHaveBeenCalledTimes(2));
});
