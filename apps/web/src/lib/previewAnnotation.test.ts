import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewAnnotationScreenshot } from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [
    {
      id: "stroke_1",
      color: "#7c3aed",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      bounds: { x: 6, y: 6, width: 18, height: 18 },
    },
  ],
  styleChanges: [
    {
      targetId: "element_1",
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("decodes the crop without fetch, which the desktop CSP refuses for data URLs", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Refused to connect: violates connect-src");
    });
    const capture = await capturePreviewAnnotationScreenshot({
      ...annotation,
      screenshot: { ...annotation.screenshot!, dataUrl: "data:image/png;base64,iVBORw==" },
    });
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") return;
    expect(capture.file.type).toBe("image/png");
    expect([...new Uint8Array(await capture.file.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });

  it("reports none when the annotation carries no crop", async () => {
    const capture = await capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null });
    expect(capture).toEqual({ status: "none" });
  });

  it("fails when the crop is not a data URL", async () => {
    const capture = await capturePreviewAnnotationScreenshot({
      ...annotation,
      screenshot: { ...annotation.screenshot!, dataUrl: "https://example.com/crop.png" },
    });
    expect(capture).toEqual({ status: "failed" });
  });
});
