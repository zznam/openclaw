/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrganizer, type SessionOrganizerDependencies } from "./session-organizer.ts";

function organizer() {
  const owner = new SessionOrganizer({} as SessionOrganizerDependencies, vi.fn());
  owner.draggingSidebarEntry = "route:sessions";
  return owner;
}

function drag(type: string, relatedTarget: EventTarget | null = null) {
  const event = new MouseEvent(type, { clientY: 5, relatedTarget });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["application/x-openclaw-session-group"], getData: () => "" },
  });
  return event as DragEvent;
}

afterEach(() => vi.restoreAllMocks());

describe("session organizer drag targets", () => {
  for (const target of [null, new EventTarget()]) {
    it.each([
      [
        "sidebar hover",
        (owner: SessionOrganizer, event: DragEvent) =>
          owner.handleSidebarZoneDragOver(event, "route:usage"),
      ],
      [
        "sidebar leave",
        (owner: SessionOrganizer, event: DragEvent) => owner.handleSidebarZoneDragLeave(event),
      ],
      [
        "session list leave",
        (owner: SessionOrganizer, event: DragEvent) => owner.handleSessionListDragLeave(event),
      ],
      [
        "section hover",
        (owner: SessionOrganizer, event: DragEvent) => owner.sectionDragOver(event, "work"),
      ],
      [
        "section leave",
        (owner: SessionOrganizer, event: DragEvent) => owner.sectionDragLeave(event, "work"),
      ],
    ] as const)(
      `ignores %s without an element target (${target === null ? "null" : "other EventTarget"})`,
      (_name, invoke) => {
        const owner = organizer();
        owner.sidebarZoneDropTarget = { entry: "route:usage", position: "before" };
        owner.sessionListRemovalDrop = true;
        owner.sessionDropTarget = "work";
        owner.sidebarSectionDropTarget = { sectionId: "work", position: "after" };
        const event = drag("dragleave", document.createElement("span"));
        Object.defineProperty(event, "currentTarget", { value: target });

        expect(() => invoke(owner, event)).not.toThrow();
        expect(owner.sidebarZoneDropTarget).toEqual({ entry: "route:usage", position: "before" });
        expect(owner.sessionListRemovalDrop).toBe(true);
        expect(owner.sessionDropTarget).toBe("work");
        expect(owner.sidebarSectionDropTarget).toEqual({ sectionId: "work", position: "after" });
      },
    );
  }

  it("uses the dispatch element geometry and preserves hover while entering its child", () => {
    const owner = organizer();
    const target = document.createElement("div");
    const child = document.createElement("span");
    target.append(child);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
    target.addEventListener("dragover", (event) =>
      owner.handleSidebarZoneDragOver(event as DragEvent, "route:usage"),
    );
    target.addEventListener("dragleave", (event) =>
      owner.handleSidebarZoneDragLeave(event as DragEvent),
    );

    target.dispatchEvent(drag("dragover"));
    expect(owner.sidebarZoneDropTarget).toEqual({ entry: "route:usage", position: "before" });
    target.dispatchEvent(drag("dragleave", child));
    expect(owner.sidebarZoneDropTarget).toEqual({ entry: "route:usage", position: "before" });
    target.dispatchEvent(drag("dragleave"));
    expect(owner.sidebarZoneDropTarget).toBeNull();
  });

  it("uses the section header geometry and clears its drop only after leaving the section", () => {
    const owner = organizer();
    const target = document.createElement("div");
    const header = document.createElement("div");
    const child = document.createElement("span");
    target.append(child);
    owner.sectionHeaders.set("work", header);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 100, 20));
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
    target.addEventListener("dragover", (event) =>
      owner.sectionDragOver(event as DragEvent, "work"),
    );
    target.addEventListener("dragleave", (event) =>
      owner.sectionDragLeave(event as DragEvent, "work"),
    );

    target.dispatchEvent(drag("dragover"));
    expect(owner.sidebarSectionDropTarget).toEqual({ sectionId: "work", position: "before" });
    target.dispatchEvent(drag("dragleave", child));
    expect(owner.sidebarSectionDropTarget).toEqual({ sectionId: "work", position: "before" });
    target.dispatchEvent(drag("dragleave"));
    expect(owner.sidebarSectionDropTarget).toBeNull();
  });

  it("preserves the removal drop within the session list and clears it on exit", () => {
    const owner = organizer();
    owner.sessionListRemovalDrop = true;
    const target = document.createElement("div");
    const child = document.createElement("span");
    target.append(child);
    target.addEventListener("dragleave", (event) =>
      owner.handleSessionListDragLeave(event as DragEvent),
    );

    target.dispatchEvent(drag("dragleave", child));
    expect(owner.sessionListRemovalDrop).toBe(true);
    target.dispatchEvent(drag("dragleave"));
    expect(owner.sessionListRemovalDrop).toBe(false);
  });
});
