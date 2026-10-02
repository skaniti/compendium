import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import PromptEditor from "./PromptEditor";
import { detail } from "./test-fixtures";
vi.mock("@/lib/prompts-api");

beforeEach(() => vi.resetAllMocks());
const setup = (over: Partial<Parameters<typeof PromptEditor>[0]> = {}) => {
  const onSaved = vi.fn(); const onCancel = vi.fn();
  render(<PromptEditor name="alpha_task_v2" liveText="live text" registryText="registry text" onSaved={onSaved} onCancel={onCancel} {...over} />);
  return { onSaved, onCancel, box: screen.getByRole("textbox", { name: "Override for alpha_task_v2" }) as HTMLTextAreaElement };
};

it("initial value, status transitions and counter", async () => {
  const { box } = setup();
  expect(box.value).toBe("live text");
  expect(screen.getByText(/9 \/ 32,000 characters/)).toBeInTheDocument();
  expect(screen.getByText(/No changes/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.type(box, "!");
  expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});
it("registry match note; blank disables save", async () => {
  const { box } = setup();
  await userEvent.clear(box);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.type(box, "registry text");
  expect(screen.getByText(/Matches the registry text: saving clears the override\./)).toBeInTheDocument();
});
it("save calls the api and onSaved with the result", async () => {
  const result = { ...detail(), cleared: false, missing_placeholders: ["title"] };
  vi.mocked(api.savePromptOverride).mockResolvedValue(result);
  const { box, onSaved } = setup();
  await userEvent.type(box, "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(api.savePromptOverride).toHaveBeenCalledWith("alpha_task_v2", "live text!");
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(result));
});
it("error keeps the draft", async () => {
  vi.mocked(api.savePromptOverride).mockRejectedValue(new Error("The template is empty."));
  const { box, onSaved } = setup();
  await userEvent.type(box, "!");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save (The template is empty.).");
  expect(box.value).toBe("live text!");
  expect(onSaved).not.toHaveBeenCalled();
});
it("cancel", async () => {
  const { onCancel } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
});
