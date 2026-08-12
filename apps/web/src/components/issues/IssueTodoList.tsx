/**
 * The todo checklist on the detail sheet.
 *
 * A todo is deliberately not a sub-issue: no key, no status, no place in the list view — which is
 * also why none of these writes append to the change log (`persistence/Services/IssueTodos.ts`),
 * and why the activity feed stays quiet while somebody ticks five boxes.
 *
 * Reorder is the same `@dnd-kit` shape the statuses settings panel uses, and it sends the whole
 * order rather than a move, because that is what `issues.todosReorder` takes.
 *
 * @module components/issues/IssueTodoList
 */
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { IssueTodo, IssueTodoId, IssueTodoPatch } from "@t3tools/contracts";
import { GripVerticalIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  issueTodoCreateText,
  issueTodoProgress,
  issueTodoTextPatch,
  issueTodoTogglePatch,
  reorderedIssueTodoIds,
} from "./issueDetail.logic";

function TodoRow({
  todo,
  onToggle,
  onRename,
  onDelete,
}: {
  todo: IssueTodo;
  onToggle: (todo: IssueTodo) => void;
  onRename: (todo: IssueTodo, text: string) => void;
  onDelete: (todo: IssueTodo) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id });

  return (
    <li
      className={cn(
        "group/todo flex items-center gap-1.5 rounded-md py-0.5 ps-0.5 pe-1",
        isDragging ? "z-10 bg-accent/50 shadow-xs" : "hover:bg-accent/30",
      )}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${todo.text}`}
        className="cursor-grab touch-none text-muted-foreground/0 group-hover/todo:text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        ref={setActivatorNodeRef}
        type="button"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <Checkbox
        aria-label={todo.text}
        checked={todo.done}
        className="size-3.5 shrink-0"
        onCheckedChange={() => onToggle(todo)}
      />
      {/* Uncontrolled and keyed on the stored text: the stream echoes every edit back, and a
          controlled field would fight the caret while a rename is in flight. */}
      <Input
        aria-label={`Edit ${todo.text}`}
        className={cn(
          "min-w-0 flex-1 border-transparent bg-transparent shadow-none dark:bg-transparent",
          todo.done && "text-muted-foreground line-through",
        )}
        defaultValue={todo.text}
        key={todo.text}
        onBlur={(event) => onRename(todo, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = todo.text;
            event.currentTarget.blur();
          }
        }}
        size="sm"
      />
      <Button
        aria-label={`Delete ${todo.text}`}
        className="text-muted-foreground opacity-0 group-hover/todo:opacity-100 hover:text-destructive-foreground focus-visible:opacity-100"
        onClick={() => onDelete(todo)}
        size="icon-xs"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

export function IssueTodoList({
  todos,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
}: {
  /** Already in position order — the state layer sorts the stream's list. */
  todos: ReadonlyArray<IssueTodo>;
  onCreate: (text: string) => void;
  onUpdate: (todoId: IssueTodoId, patch: IssueTodoPatch) => void;
  onDelete: (todoId: IssueTodoId) => void;
  onReorder: (todoIds: ReadonlyArray<IssueTodoId>) => void;
}) {
  const [draft, setDraft] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const progress = useMemo(() => issueTodoProgress(todos), [todos]);

  const submitDraft = () => {
    const text = issueTodoCreateText(draft);
    if (text === null) return;
    setDraft("");
    onCreate(text);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null) return;
    const todoIds = reorderedIssueTodoIds({ todos, activeId: String(event.active.id), overId });
    if (todoIds === null) return;
    onReorder(todoIds);
  };

  return (
    <section className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Todos</h3>
        {progress.total === 0 ? null : (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {todos.length === 0 ? null : (
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
          <SortableContext
            items={todos.map((todo) => todo.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  onDelete={(target) => onDelete(target.id)}
                  onRename={(target, raw) => {
                    const patch = issueTodoTextPatch(target, raw);
                    if (patch !== null) onUpdate(target.id, patch);
                  }}
                  onToggle={(target) => onUpdate(target.id, issueTodoTogglePatch(target))}
                  todo={todo}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <div className="flex items-center gap-1.5 ps-5">
        <Input
          aria-label="New todo"
          className="min-w-0 flex-1 border-transparent bg-transparent shadow-none dark:bg-transparent"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submitDraft();
          }}
          placeholder="Add a todo…"
          size="sm"
          value={draft}
        />
      </div>
    </section>
  );
}
