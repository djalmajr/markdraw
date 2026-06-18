import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { switchLocale } from "@markdraw/i18n/solid";

// The viewer's labels are i18n'd; pin English so the text assertions below
// match regardless of the host's detected locale.
beforeEach(() => switchLocale("en"));

// The `?url` worker import resolves to a string asset; stub it so the
// suite never touches the real worker file path.
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "pdf.worker.js" }));

// pdf.js is heavy and canvas-bound — mock it so the suite exercises the
// viewer's own page/zoom logic, not pdf rendering. `getDocument` yields a
// 3-page doc; pages report a fixed viewport and a render task that resolves.
const getPage = vi.fn(async () => ({
  getViewport: () => ({ width: 600, height: 800 }),
  render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 3, getPage, destroy: () => {} }),
  }),
}));

import { MediaViewer } from "./media-viewer.tsx";

describe("MediaViewer — image", () => {
  it("renders an <img> pointing at the resolved asset src", () => {
    // Mutation: dropping the src binding (or hardcoding it) leaves the
    // viewer blank — the image would never resolve off disk.
    const { container } = render(() => (
      <MediaViewer kind="image" src="asset://photo.png" fileName="photo.png" />
    ));
    const img = container.querySelector<HTMLImageElement>("img.media-image");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("asset://photo.png");
    expect(img!.getAttribute("alt")).toBe("photo.png");
  });

  it("starts in fit mode and shows 'Fit', then zoom in switches to a percentage", () => {
    // Mutation: if zoomIn forgets to clear fit() the label stays "Fit"
    // and the image never leaves object-fit, so explicit zoom is dead.
    const { getByText, getByLabelText, container } = render(() => (
      <MediaViewer kind="image" src="asset://photo.png" fileName="photo.png" />
    ));
    expect(getByText("Fit")).not.toBeNull();
    expect(container.querySelector(".media-image-fit")).not.toBeNull();

    fireEvent.click(getByLabelText("Zoom in"));
    expect(getByText("125%")).not.toBeNull();
    expect(container.querySelector(".media-image-fit")).toBeNull();
  });

  it("fit button returns to fit mode after zooming", () => {
    const { getByText, getByLabelText } = render(() => (
      <MediaViewer kind="image" src="asset://photo.png" fileName="photo.png" />
    ));
    fireEvent.click(getByLabelText("Zoom in"));
    expect(getByText("125%")).not.toBeNull();
    fireEvent.click(getByLabelText("Fit to window"));
    expect(getByText("Fit")).not.toBeNull();
  });

  it("shows a fallback message when the host can't resolve the src", () => {
    const { getByText } = render(() => (
      <MediaViewer kind="image" src={null} fileName="photo.png" />
    ));
    expect(getByText("Unable to load photo.png")).not.toBeNull();
  });
});

describe("MediaViewer — pdf continuous scroll", () => {
  it("renders one canvas per page stacked in a column (no page navigation)", async () => {
    // Mutation: hardcoding a single canvas (or rendering only the current
    // page) drops the continuous-scroll contract — the user would be back
    // to paging. The count must track the doc's numPages.
    const { findByText, container, queryByLabelText } = render(() => (
      <MediaViewer kind="pdf" src="asset://doc.pdf" fileName="doc.pdf" />
    ));

    expect(await findByText("3 pages")).not.toBeNull();
    expect(container.querySelectorAll(".media-pdf-page").length).toBe(3);
    // No page-navigation controls in continuous mode.
    expect(queryByLabelText("Next page")).toBeNull();
    expect(queryByLabelText("Previous page")).toBeNull();
  });

  it("renders the PDF fit control as 'Fit width' (not the image label)", async () => {
    const { findByText, getByLabelText } = render(() => (
      <MediaViewer kind="pdf" src="asset://doc.pdf" fileName="doc.pdf" />
    ));
    await findByText("3 pages");
    expect(getByLabelText("Fit width")).not.toBeNull();
  });

  it("surfaces a load error instead of a blank canvas", async () => {
    getPage.mockClear();
    // Re-mock getDocument to reject for this case only.
    const pdfjs = await import("pdfjs-dist");
    const spy = vi
      .spyOn(pdfjs, "getDocument")
      .mockReturnValueOnce({ promise: Promise.reject(new Error("bad pdf")) } as ReturnType<
        typeof pdfjs.getDocument
      >);

    const { findByText } = render(() => (
      <MediaViewer kind="pdf" src="asset://broken.pdf" fileName="broken.pdf" />
    ));
    await waitFor(() =>
      expect(findByText("Unable to display broken.pdf")).resolves.not.toBeNull(),
    );
    spy.mockRestore();
  });
});

describe("MediaViewer — i18n", () => {
  it("renders labels in pt-BR after switchLocale", async () => {
    // Mutation captured: reverting any label to a hardcoded English
    // string (e.g. aria-label="Zoom in", or "{n} pages") leaves it
    // English under pt-BR and these queries fail. Pins the
    // (useLocale(), m.x()) tracking too — drop the comma-operator and
    // the node freezes on the en value from the previous test.
    switchLocale("pt-BR");
    const { findByText, getByLabelText } = render(() => (
      <MediaViewer kind="pdf" src="asset://doc.pdf" fileName="doc.pdf" />
    ));
    expect(await findByText("3 páginas")).not.toBeNull();
    expect(getByLabelText("Aumentar zoom")).not.toBeNull();
    expect(getByLabelText("Diminuir zoom")).not.toBeNull();
    expect(getByLabelText("Ajustar à largura")).not.toBeNull();
    switchLocale("en");
  });
});
