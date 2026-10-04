import "@testing-library/jest-dom/vitest";

// jsdom has no canvas: return null quietly (the real no-canvas path) instead of
// logging "Not implemented" for every getContext call.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
