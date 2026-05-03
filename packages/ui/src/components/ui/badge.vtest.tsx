import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { Badge } from "./badge.tsx";

describe("Badge", () => {
  it("renders children inside a div", () => {
    const { getByText } = render(() => <Badge>New</Badge>);
    const node = getByText("New");
    expect(node.tagName.toLowerCase()).toBe("div");
  });

  it("applies the default variant class when no variant prop is provided", () => {
    const { getByText } = render(() => <Badge>Default</Badge>);
    expect(getByText("Default").className).toContain("bg-primary");
  });

  it("switches classes per variant", () => {
    const { getByText } = render(() => <Badge variant="error">Boom</Badge>);
    expect(getByText("Boom").className).toContain("bg-error");
  });

  it("merges user-provided classes with the variant classes via cn()", () => {
    const { getByText } = render(() => (
      <Badge class="custom-test-class">User</Badge>
    ));
    const node = getByText("User");
    expect(node.className).toContain("custom-test-class");
    expect(node.className).toContain("bg-primary");
  });

  it("toggles round modifier (rounded-full) when round prop is set", () => {
    const { getByText } = render(() => <Badge round>Pill</Badge>);
    expect(getByText("Pill").className).toContain("rounded-full");
  });
});
