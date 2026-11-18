import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

import {
  TextField,
  TextFieldDescription,
  TextFieldErrorMessage,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "./text-field.tsx";

describe("TextField", () => {
  it("reports typed text through the root onChange (public contract)", () => {
    const log: string[] = [];
    const { getByRole } = render(() => (
      <TextField value="" onChange={(value) => log.push(value)}>
        <TextFieldLabel>Key</TextFieldLabel>
        <TextFieldInput placeholder="key" />
      </TextField>
    ));
    const input = getByRole("textbox") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "abc" } });
    flush();
    expect(log).toEqual(["abc"]);
    expect(input.getAttribute("type")).toBe("text");
  });

  it("associates label, description and error with the control in ARIA", () => {
    const { getByRole, getByText } = render(() => (
      <TextField validationState="invalid" name="key">
        <TextFieldLabel>Key</TextFieldLabel>
        <TextFieldInput />
        <TextFieldDescription>Visible hint</TextFieldDescription>
        <TextFieldErrorMessage>Bad key</TextFieldErrorMessage>
      </TextField>
    ));
    const input = getByRole("textbox");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(getByText("Key")).not.toBeNull();
    expect(describedBy.length).toBeGreaterThan(0);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getByText("Bad key")).not.toBeNull();
  });

  it("respects a controlled value from the root", () => {
    const { getByRole } = render(() => (
      <TextField value="fixed">
        <TextFieldInput />
      </TextField>
    ));
    expect((getByRole("textbox") as HTMLInputElement).value).toBe("fixed");
  });

  it("supports Textarea under the same root", () => {
    const log: string[] = [];
    const { getByRole } = render(() => (
      <TextField onChange={(value) => log.push(value)}>
        <TextFieldTextArea />
      </TextField>
    ));
    const area = getByRole("textbox") as HTMLTextAreaElement;
    expect(area.tagName.toLowerCase()).toBe("textarea");
    fireEvent.input(area, { target: { value: "hello" } });
    flush();
    expect(log).toEqual(["hello"]);
  });

  it("disables the control when the root is disabled", () => {
    const { getByRole } = render(() => (
      <TextField disabled>
        <TextFieldInput />
      </TextField>
    ));
    expect((getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  });
});
