"use client";

import {
  memo,
  useState,
  useMemo,
  useEffect,
  forwardRef,
  useCallback,
  useRef,
  useId,
} from "react";
import {
  useForm,
  useFieldArray,
  useFormContext,
  useWatch,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { editComponents } from "@/fields/registry";
import {
  initializeState,
  getDefaultValue,
  generateZodSchema,
  sanitizeObject,
  getSchemaByName,
  getFieldByPath,
} from "@/lib/schema";
import { useConfig } from "@/contexts/config-context";
import { Thumbnail } from "@/components/thumbnail";
import { MediaUpload } from "@/components/media/media-upload";
import { MediaDialog } from "@/components/media/media-dialog";
import { getAllowedExtensions } from "@/fields/core/image";
import { normalizeMediaPath, normalizePath } from "@/lib/utils/file";
import { parseAspectRatio } from "@/lib/utils/aspect-ratio";
import type { FileSaveData } from "@/types/api";
import { Field } from "@/types/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  Ban,
  Asterisk,
  X,
  GripVertical,
  Plus,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  FolderOpen,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { interpolate } from "@/lib/schema";

type BeforeSubmitHook = () => void | Promise<void>;
type RegisterBeforeSubmitHook = (
  key: string,
  hook: BeforeSubmitHook,
) => () => void;

type FieldWithReadonlyMeta = Field & {
  __inheritedReadonly?: boolean;
};

type RenderFields = (
  fields: FieldWithReadonlyMeta[],
  parentName?: string,
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook,
  runBeforeSubmitHooks?: () => Promise<void>,
  inheritedReadonly?: boolean,
  keyPrefix?: string,
) => React.ReactNode[];

type NestedFieldProps = {
  field: FieldWithReadonlyMeta;
  fieldName: string;
  renderFields: RenderFields;
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  index?: number;
  keyPrefix?: string;
};

const hasFieldPathError = (errors: unknown, fieldName: string): boolean => {
  let current: unknown = errors;
  for (const part of fieldName.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return Boolean(current);
};

const getCollapsibleItemLabel = (
  field: Field,
  fieldValues: unknown,
  index?: number,
): string => {
  if (
    typeof field.list === "object" &&
    field.list.collapsible &&
    typeof field.list.collapsible === "object" &&
    field.list.collapsible.summary
  ) {
    return interpolate(
      field.list.collapsible.summary,
      {
        index: index !== undefined ? `${index + 1}` : "",
        fields: fieldValues as Record<string, unknown>,
      },
      "fields",
    );
  }

  return `Item ${index !== undefined ? `#${index + 1}` : ""}`;
};

const hasCollapsibleSummary = (field: Field) =>
  typeof field.list === "object" &&
  !!field.list.collapsible &&
  typeof field.list.collapsible === "object" &&
  !!field.list.collapsible.summary;

const hasExplicitReadonly = (field: Field) =>
  Boolean(field.readonly) &&
  !(field as FieldWithReadonlyMeta).__inheritedReadonly;

const SortableItem = ({
  id,
  children,
  readonly = false,
}: {
  id: string;
  children: React.ReactNode;
  readonly?: boolean;
}) => {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-x-1",
        isDragging ? "opacity-50 z-50" : "z-10",
      )}
      style={style}
    >
      {!readonly && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-auto w-6 self-stretch cursor-move text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </Button>
      )}
      {children}
    </div>
  );
};

const ListItemRow = memo(function ListItemRow({
  id,
  field,
  fieldName,
  index,
  isOpen,
  defaultOpen,
  isPendingRemove,
  renderFields,
  registerBeforeSubmitHook,
  onToggleOpen,
  onRequestRemove,
  onRemoveConfirm,
  onPendingRemoveChange,
}: {
  id: string;
  field: FieldWithReadonlyMeta;
  fieldName: string;
  index: number;
  isOpen?: boolean;
  defaultOpen: boolean;
  isPendingRemove: boolean;
  renderFields: RenderFields;
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook;
  onToggleOpen: (index: number) => void;
  onRequestRemove: (index: number) => void;
  onRemoveConfirm: (index: number) => void;
  onPendingRemoveChange: (index: number, open: boolean) => void;
}) {
  const isReadonly = Boolean(field.readonly);
  return (
    <SortableItem id={id} readonly={isReadonly}>
      <div className="grid gap-6 flex-1">
        <SingleField
          field={field}
          fieldName={`${fieldName}.${index}`}
          keyPrefix={id}
          renderFields={renderFields}
          registerBeforeSubmitHook={registerBeforeSubmitHook}
          showLabel={false}
          isOpen={isOpen ?? defaultOpen}
          toggleOpen={() => onToggleOpen(index)}
          index={index}
        />
      </div>
      {!isReadonly && (
        <Tooltip>
          <AlertDialog
            open={isPendingRemove}
            onOpenChange={(open) => onPendingRemoveChange(index, open)}
          >
            <TooltipTrigger asChild>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground self-start"
                  onClick={() => onRequestRemove(index)}
                >
                  <Trash2 />
                </Button>
              </AlertDialogTrigger>
            </TooltipTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove this item?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRemoveConfirm(index)}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <TooltipContent>Remove item</TooltipContent>
        </Tooltip>
      )}
    </SortableItem>
  );
});

type ListGridConfig = {
  columns: number;
  aspectRatio: string;
  // Path of the image inside each item; null when the item itself is the image.
  imageKey: string | null;
  imageField?: Field;
};

const getListGridConfig = (field: Field): ListGridConfig | null => {
  if (typeof field.list !== "object" || !field.list?.grid) return null;
  if (!["object", "image"].includes(field.type)) return null;
  const grid = field.list.grid;

  let imageKey: string | null = null;
  let imageField: Field | undefined;
  if (field.type === "image") {
    imageField = field;
  } else {
    imageKey =
      grid.image ??
      field.fields?.find((subfield) => subfield.type === "image")?.name ??
      null;
    imageField = imageKey && field.fields ? getFieldByPath(field.fields, imageKey) : undefined;
  }

  return {
    columns: grid.columns ?? 4,
    aspectRatio: parseAspectRatio(grid.aspect),
    imageKey,
    imageField,
  };
};

const GridTile = memo(function GridTile({
  id,
  fieldName,
  index,
  imageKey,
  media,
  aspectRatio,
  readonly,
  canRemove,
  onOpen,
  onRequestRemove,
}: {
  id: string;
  fieldName: string;
  index: number;
  imageKey: string | null;
  media?: string;
  aspectRatio: string;
  readonly: boolean;
  canRemove: boolean;
  onOpen: (index: number) => void;
  onRequestRemove: (index: number) => void;
}) {
  const itemName = `${fieldName}.${index}`;
  const {
    control,
    formState: { errors },
  } = useFormContext();
  const imageValue = useWatch({
    control,
    name: imageKey ? `${itemName}.${imageKey}` : itemName,
  });
  const imagePath = Array.isArray(imageValue) ? imageValue[0] : imageValue;
  const hasErrors = hasFieldPathError(errors, itemName);

  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id, disabled: readonly });

  return (
    <div
      ref={setNodeRef}
      className={cn("group relative min-w-0", isDragging ? "opacity-50 z-50" : "z-10")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <button
        type="button"
        className={cn(
          "block w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasErrors && "ring-2 ring-destructive",
          !readonly && "cursor-move",
        )}
        onClick={() => onOpen(index)}
        onPointerDown={readonly ? undefined : (listeners?.onPointerDown as React.PointerEventHandler | undefined)}
        aria-label={`Edit item #${index + 1}`}
      >
        <Thumbnail
          name={media ?? ""}
          path={typeof imagePath === "string" && imagePath ? imagePath : null}
          className="aspect-auto rounded-md"
          style={{ aspectRatio }}
        />
      </button>
      {!readonly && (
        <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="cursor-move"
            aria-label="Reorder item"
            {...attributes}
            {...listeners}
          >
            <GripVertical />
          </Button>
          {canRemove && (
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              aria-label="Remove item"
              onClick={() => onRequestRemove(index)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

const ListGrid = ({
  field,
  fieldName,
  grid,
  arrayFields,
  renderFields,
  registerBeforeSubmitHook,
  onAppend,
  onRemove,
  onMove,
}: {
  field: FieldWithReadonlyMeta;
  fieldName: string;
  grid: ListGridConfig;
  arrayFields: { id: string }[];
  renderFields: RenderFields;
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook;
  onAppend: (items: unknown[]) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) => {
  const { config } = useConfig();
  const isReadonly = Boolean(field.readonly);
  const listOptions = typeof field.list === "object" ? field.list : undefined;
  const min = listOptions?.min ?? 0;
  const max = listOptions?.max;
  const remainingSlots = max ? max - arrayFields.length : Infinity;
  const canRemove = arrayFields.length > min;

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [pendingRemoveIndex, setPendingRemoveIndex] = useState<number | null>(null);

  const imageOptions = (grid.imageField?.options ?? {}) as {
    media?: string | false;
    path?: string;
    multiple?: unknown;
    rename?: boolean | "safe" | "random";
  };
  const mediaConfig = useMemo(() => {
    if (!config?.object?.media?.length || imageOptions.media === false) return undefined;
    return typeof imageOptions.media === "string"
      ? getSchemaByName(config.object, imageOptions.media, "media")
      : config.object.media[0];
  }, [config?.object, imageOptions.media]);
  const uploadPath = imageOptions.path ? normalizePath(imageOptions.path) : mediaConfig?.input;
  const allowedExtensions = useMemo(
    () => (grid.imageField && mediaConfig ? getAllowedExtensions(grid.imageField, mediaConfig) : undefined),
    [grid.imageField, mediaConfig],
  );

  // Builds a new list item with the image filled in.
  const createItem = useCallback(
    (imagePath?: string) => {
      const path = imagePath ? normalizeMediaPath(imagePath) : undefined;
      const imageValue = path && imageOptions.multiple ? [path] : path;
      if (field.type === "image") return imageValue ?? getDefaultValue({ ...field, list: undefined });
      const item = initializeState(field.fields, {});
      if (grid.imageKey && imageValue !== undefined) {
        // Support dotted paths (e.g. "photo.src") for the image subfield.
        const keys = grid.imageKey.split(".");
        let target = item;
        keys.slice(0, -1).forEach((key) => {
          target[key] = target[key] ?? {};
          target = target[key];
        });
        target[keys[keys.length - 1]] = imageValue;
      }
      return item;
    },
    [field, grid.imageKey, imageOptions.multiple],
  );

  const addEmptyItem = () => {
    onAppend([createItem()]);
    setEditingIndex(arrayFields.length);
  };

  const addImages = useCallback(
    (paths: string[]) => {
      const allowed = Number.isFinite(remainingSlots) ? paths.slice(0, Math.max(remainingSlots, 0)) : paths;
      if (allowed.length) onAppend(allowed.map((path) => createItem(path)));
    },
    [createItem, onAppend, remainingSlots],
  );

  const handleUpload = useCallback(
    (fileData: FileSaveData) => {
      if (fileData.path) addImages([fileData.path]);
    },
    [addImages],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableItems = useMemo(() => arrayFields.map((item) => item.id), [arrayFields]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (isReadonly) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = arrayFields.findIndex((item) => item.id === active.id);
    const newIndex = arrayFields.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onMove(oldIndex, newIndex);
  };

  const handleRequestRemove = useCallback((index: number) => setPendingRemoveIndex(index), []);
  const handleOpen = useCallback((index: number) => setEditingIndex(index), []);

  // Edit the item without list chrome (collapsible header, list description); it's a single item in a dialog.
  const itemField = useMemo<FieldWithReadonlyMeta>(
    () => ({ ...field, list: undefined, description: undefined }),
    [field],
  );
  const editingId = editingIndex !== null ? arrayFields[editingIndex]?.id : undefined;
  const canUseMedia = Boolean(mediaConfig && grid.imageField);
  const canAdd = !isReadonly && remainingSlots > 0;

  const gridNode = (
    <div className="space-y-2">
      {arrayFields.length > 0 ? (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}
        >
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableItems} strategy={rectSortingStrategy}>
              {arrayFields.map((arrayField, index) => (
                <GridTile
                  key={arrayField.id}
                  id={arrayField.id}
                  fieldName={fieldName}
                  index={index}
                  imageKey={grid.imageKey}
                  media={mediaConfig?.name}
                  aspectRatio={grid.aspectRatio}
                  readonly={isReadonly}
                  canRemove={canRemove}
                  onOpen={handleOpen}
                  onRequestRemove={handleRequestRemove}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No items
        </div>
      )}
      {canAdd && (
        <div className="flex items-center gap-2 flex-wrap">
          {canUseMedia && (
            <>
              <MediaUpload.Trigger>
                <Button type="button" variant="outline" size="sm">
                  <Upload />
                  Upload
                </Button>
              </MediaUpload.Trigger>
              <MediaDialog
                media={mediaConfig.name}
                initialPath={uploadPath}
                maxSelected={Number.isFinite(remainingSlots) ? remainingSlots : undefined}
                extensions={allowedExtensions}
                onSubmit={addImages}
              >
                <Button type="button" variant="outline" size="sm">
                  <FolderOpen />
                  Select
                </Button>
              </MediaDialog>
            </>
          )}
          <Button type="button" variant="outline" size="sm" onClick={addEmptyItem}>
            <Plus />
            Add an item
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {canUseMedia ? (
        <MediaUpload
          path={uploadPath}
          media={mediaConfig.name}
          extensions={allowedExtensions}
          onUpload={handleUpload}
          multiple
          rename={imageOptions.rename ?? mediaConfig.rename}
          disabled={!canAdd}
        >
          <MediaUpload.DropZone>{gridNode}</MediaUpload.DropZone>
        </MediaUpload>
      ) : (
        gridNode
      )}
      <Dialog
        open={editingIndex !== null && editingId !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingIndex(null);
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          onOpenAutoFocus={(event) => {
            // Focus the dialog itself rather than the first control (which opens its tooltip).
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {field.label || field.name} #{(editingIndex ?? 0) + 1}
            </DialogTitle>
            <DialogDescription className="sr-only">Edit this item.</DialogDescription>
          </DialogHeader>
          {editingIndex !== null && editingId && (
            <div className="grid gap-6">
              <SingleField
                field={itemField}
                fieldName={`${fieldName}.${editingIndex}`}
                keyPrefix={editingId}
                renderFields={renderFields}
                registerBeforeSubmitHook={registerBeforeSubmitHook}
                showLabel={false}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setEditingIndex(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={pendingRemoveIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoveIndex(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this item?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemoveIndex !== null) onRemove(pendingRemoveIndex);
                setPendingRemoveIndex(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const ListField = ({
  field,
  fieldName,
  renderFields,
  registerBeforeSubmitHook,
  runBeforeSubmitHooks,
}: {
  field: FieldWithReadonlyMeta;
  fieldName: string;
  renderFields: RenderFields;
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook;
  runBeforeSubmitHooks?: () => Promise<void>;
}) => {
  const gridConfig = useMemo(() => getListGridConfig(field), [field]);
  const supportsItemCollapse =
    field.type === "object" || field.type === "block";
  const isCollapsible = !!(
    !gridConfig &&
    supportsItemCollapse &&
    field.list &&
    !(typeof field.list === "object" && field.list?.collapsible === false)
  );
  const defaultOpen = useMemo(() => {
    const defaultCollapsed =
      isCollapsible &&
      typeof field.list === "object" &&
      field.list.collapsible &&
      typeof field.list.collapsible === "object" &&
      field.list.collapsible.collapsed;
    return !defaultCollapsed;
  }, [field.list, isCollapsible]);

  const {
    fields: arrayFields,
    append,
    remove,
    move,
  } = useFieldArray({
    name: fieldName,
  });
  const [openStates, setOpenStates] = useState<boolean[]>([]);
  const shouldShowListHeader =
    field.label !== false ||
    field.required ||
    (isCollapsible && arrayFields.length > 0);
  const isReadonly = Boolean(field.readonly);

  useEffect(() => {
    setOpenStates((prev) => {
      if (prev.length === arrayFields.length) {
        return prev;
      }
      if (prev.length === 0 && arrayFields.length > 0) {
        return Array(arrayFields.length).fill(defaultOpen);
      }
      if (prev.length < arrayFields.length) {
        return [
          ...prev,
          ...Array(arrayFields.length - prev.length).fill(defaultOpen),
        ];
      }
      return prev.slice(0, arrayFields.length);
    });
  }, [arrayFields.length, defaultOpen]);

  const toggleOpen = useCallback((index: number) => {
    setOpenStates((prev) =>
      prev.map((isOpen, currentIndex) =>
        currentIndex === index ? !isOpen : isOpen,
      ),
    );
  }, []);

  const handleDragEnd = async (event: DragEndEvent) => {
    if (isReadonly) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = arrayFields.findIndex((item) => item.id === active.id);
    const newIndex = arrayFields.findIndex((item) => item.id === over.id);

    if (oldIndex < 0 || newIndex < 0) return;

    await runBeforeSubmitHooks?.();
    setOpenStates((prev) => arrayMove(prev, oldIndex, newIndex));
    move(oldIndex, newIndex);
  };

  const addItem = async () => {
    if (isReadonly) return;
    await runBeforeSubmitHooks?.();
    append(
      field.type === "object"
        ? initializeState(field.fields, {})
        : getDefaultValue(field),
    );
    setOpenStates((prev) => [...prev, true]);
  };

  const removeItem = useCallback(
    async (index: number) => {
      if (isReadonly) return;
      await runBeforeSubmitHooks?.();
      remove(index);
      setOpenStates((prev) =>
        prev.filter((_, currentIndex) => currentIndex !== index),
      );
    },
    [isReadonly, remove, runBeforeSubmitHooks],
  );
  const [pendingRemoveIndex, setPendingRemoveIndex] = useState<number | null>(
    null,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const modifiers = useMemo(
    () => [restrictToVerticalAxis, restrictToParentElement],
    [],
  );
  const sortableItems = useMemo(
    () => arrayFields.map((item) => item.id),
    [arrayFields],
  );

  const handleToggleOpen = useCallback(
    (index: number) => {
      toggleOpen(index);
    },
    [toggleOpen],
  );
  const handleRequestRemove = useCallback((index: number) => {
    setPendingRemoveIndex(index);
  }, []);
  const handlePendingRemoveChange = useCallback(
    (index: number, open: boolean) => {
      if (open) return;
      setPendingRemoveIndex((prev) => (prev === index ? null : prev));
    },
    [],
  );
  const handleRemoveConfirm = useCallback(
    (index: number) => {
      removeItem(index);
      setPendingRemoveIndex(null);
    },
    [removeItem],
  );

  const toggleAll = (collapsed: boolean) => {
    setOpenStates(Array(arrayFields.length).fill(!collapsed));
  };

  // Synchronous on purpose: the media dialog closes right after this, and a
  // deferred append lands mid-close. Grid items only mount editors inside the
  // item dialog, so there are no pending before-submit hooks to flush here.
  const handleGridAppend = useCallback(
    (items: unknown[]) => {
      if (isReadonly) return;
      append(items);
    },
    [append, isReadonly],
  );
  const handleGridMove = useCallback(
    async (from: number, to: number) => {
      if (isReadonly) return;
      await runBeforeSubmitHooks?.();
      move(from, to);
    },
    [isReadonly, move, runBeforeSubmitHooks],
  );

  // We don't render <FormMessage/> in ListField, because it's already rendered in the individual fields
  return (
    <FormField
      name={fieldName}
      render={() => (
        <FormItem>
          {shouldShowListHeader && (
            <div className="flex items-center h-5 gap-x-2">
              {field.label !== false && (
                <FormLabel className="text-sm font-medium">
                  {field.label || field.name}
                </FormLabel>
              )}
              {field.required && (
                <Badge variant="secondary" className="text-muted-foreground">
                  <Asterisk className="-ml-1 -mr-0.5" />
                  Required
                </Badge>
              )}
              {hasExplicitReadonly(field) && (
                <Badge variant="secondary" className="text-muted-foreground">
                  <Ban className="-ml-0.5" />
                  Readonly
                </Badge>
              )}
              {isCollapsible &&
                arrayFields.length > 0 &&
                (() => {
                  const isAllExpanded =
                    openStates.length > 0 && openStates.every(Boolean);
                  return (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      onClick={() => toggleAll(isAllExpanded)}
                    >
                      {isAllExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
                      {isAllExpanded ? "Collapse all" : "Expand all"}
                    </Button>
                  );
                })()}
            </div>
          )}
          {gridConfig ? (
            <div className="space-y-2">
              <ListGrid
                field={field}
                fieldName={fieldName}
                grid={gridConfig}
                arrayFields={arrayFields}
                renderFields={renderFields}
                registerBeforeSubmitHook={registerBeforeSubmitHook}
                onAppend={handleGridAppend}
                onRemove={removeItem}
                onMove={handleGridMove}
              />
              <FormMessage />
            </div>
          ) : (
          <div className="space-y-2">
            <DndContext
              sensors={sensors}
              modifiers={modifiers}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sortableItems}
                strategy={verticalListSortingStrategy}
              >
                {arrayFields.map((arrayField, index) => (
                  <ListItemRow
                    key={arrayField.id}
                    id={arrayField.id}
                    field={field}
                    fieldName={fieldName}
                    index={index}
                    isOpen={openStates[index]}
                    defaultOpen={defaultOpen}
                    isPendingRemove={pendingRemoveIndex === index}
                    renderFields={renderFields}
                    registerBeforeSubmitHook={registerBeforeSubmitHook}
                    onToggleOpen={handleToggleOpen}
                    onRequestRemove={handleRequestRemove}
                    onRemoveConfirm={handleRemoveConfirm}
                    onPendingRemoveChange={handlePendingRemoveChange}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <div className="flex items-center gap-2 flex-wrap">
              {isReadonly ? null : typeof field.list === "object" &&
                field.list?.max &&
                arrayFields.length >= field.list.max ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addItem}
                >
                  <Plus />
                  Add an item
                </Button>
              )}
            </div>
            <FormMessage />
          </div>
          )}
        </FormItem>
      )}
    />
  );
};

const BlocksField = forwardRef<HTMLDivElement, NestedFieldProps>(
  (props, ref) => {
    const {
      field,
      fieldName,
      renderFields,
      registerBeforeSubmitHook,
      isOpen,
      onToggleOpen,
      index,
      keyPrefix,
    } = props;

    const isCollapsible = !!(
      field.list &&
      !(typeof field.list === "object" && field.list?.collapsible === false)
    );

    const {
      control,
      setValue,
      formState: { errors },
    } = useFormContext();

    const value = useWatch({ control, name: fieldName });
    const onChange = (val: Record<string, unknown> | null) => {
      setValue(fieldName, val, { shouldDirty: true });
    };

    const hasErrors = () => {
      return hasFieldPathError(errors, fieldName);
    };

    const { blocks = [] } = field;
    const blockKey = field.blockKey || "_block";
    const selectedBlockName = value?.[blockKey];
    const [isRemoveBlockDialogOpen, setIsRemoveBlockDialogOpen] =
      useState(false);
    const isReadonly = Boolean(field.readonly);

    const handleBlockSelect = (blockName: string) => {
      if (isReadonly) return;
      const selectedBlockDef = blocks.find((b: Field) => b.name === blockName);
      if (!selectedBlockDef) return;
      let initialState: Record<string, unknown> = { [blockKey]: blockName };
      if (selectedBlockDef.fields) {
        const choiceDefaults = initializeState(selectedBlockDef.fields, {});
        initialState = { ...initialState, ...choiceDefaults };
      }
      onChange(initialState);
    };

    const handleRemoveBlock = () => {
      if (isReadonly) return;
      onChange(null);
    };

    const selectedBlockDefinition = useMemo(() => {
      const definition = blocks.find(
        (b: Field) => b.name === selectedBlockName,
      );
      return definition;
    }, [blocks, selectedBlockName]);

    const itemLabel = getCollapsibleItemLabel(field, value, index);

    return (
      <div className="space-y-3" ref={ref as React.Ref<HTMLDivElement>}>
        {!selectedBlockDefinition ? (
          <div className="rounded-lg border p-4 space-y-4">
            <div className="text-sm">Choose content block:</div>
            <div className="flex flex-wrap gap-2">
              {blocks.map((blockDef: Field) => (
                <Button
                  key={blockDef.name}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-x-2"
                  onClick={() => handleBlockSelect(blockDef.name)}
                  disabled={isReadonly}
                >
                  {blockDef.label || blockDef.name}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="border rounded-lg">
            <header
              className={cn(
                "flex items-center gap-x-2 px-4 h-8.5 text-sm font-medium transition-colors rounded-t-lg",
                isOpen ? "" : "rounded-b-lg",
                isCollapsible ? "cursor-pointer hover:bg-muted" : "",
              )}
              onClick={isCollapsible ? onToggleOpen : undefined}
            >
              {isCollapsible && (
                <>
                  <ChevronRight
                    className={cn(
                      "size-4 transition-transform shrink-0",
                      isOpen ? "rotate-90" : "",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate",
                      hasErrors() ? "text-destructive" : "",
                    )}
                  >
                    {itemLabel}
                  </span>
                </>
              )}
              <Badge
                className="text-muted-foreground ml-auto -mr-2"
                variant="outline"
              >
                {selectedBlockDefinition.label || selectedBlockDefinition.name}

                {!isReadonly && (
                  <Tooltip>
                    <AlertDialog
                      open={isRemoveBlockDialogOpen}
                      onOpenChange={setIsRemoveBlockDialogOpen}
                    >
                      <TooltipTrigger asChild>
                        <AlertDialogTrigger asChild>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setIsRemoveBlockDialogOpen(true);
                            }}
                            className="text-muted-foreground hover:text-foreground -my-0.5 -mx-2 px-2 transition-colors"
                          >
                            <X className="size-3" />
                          </button>
                        </AlertDialogTrigger>
                      </TooltipTrigger>
                      <AlertDialogContent
                        onClick={(event) => event.stopPropagation()}
                      >
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Remove this block?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              handleRemoveBlock();
                              setIsRemoveBlockDialogOpen(false);
                            }}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <TooltipContent>Remove block</TooltipContent>
                  </Tooltip>
                )}
              </Badge>
            </header>
            <div
              className={cn("p-4 grid gap-6 border-t", isOpen ? "" : "hidden")}
            >
              {selectedBlockDefinition.type === "object" ? (
                (() => {
                  const renderedElements = renderFields(
                    selectedBlockDefinition.fields || [],
                    fieldName,
                    registerBeforeSubmitHook,
                    undefined,
                    isReadonly,
                    keyPrefix,
                  );
                  return renderedElements;
                })()
              ) : (
                <SingleField
                  field={
                    isReadonly
                      ? {
                          ...selectedBlockDefinition,
                          readonly: true,
                          __inheritedReadonly: true,
                        }
                      : selectedBlockDefinition
                  }
                  fieldName={fieldName}
                  keyPrefix={keyPrefix}
                  renderFields={renderFields}
                  registerBeforeSubmitHook={registerBeforeSubmitHook}
                  showLabel={false}
                />
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);

BlocksField.displayName = "BlocksField";

const ObjectFieldSummaryLabel = ({
  field,
  fieldName,
  index,
}: {
  field: FieldWithReadonlyMeta;
  fieldName: string;
  index?: number;
}) => {
  const { control } = useFormContext();
  const fieldValues = useWatch({ control, name: fieldName });
  return <>{getCollapsibleItemLabel(field, fieldValues, index)}</>;
};

const ObjectField = forwardRef<HTMLDivElement, NestedFieldProps>(
  (props, ref) => {
    const {
      field,
      fieldName,
      renderFields,
      registerBeforeSubmitHook,
      isOpen = true,
      onToggleOpen = () => {},
      index,
      keyPrefix,
    } = props;

    const isCollapsible = !!(
      field.list &&
      !(typeof field.list === "object" && field.list?.collapsible === false)
    );

    const {
      formState: { errors },
    } = useFormContext();

    const hasErrors = () => {
      return hasFieldPathError(errors, fieldName);
    };

    const itemLabel = hasCollapsibleSummary(field) ? (
      <ObjectFieldSummaryLabel
        field={field}
        fieldName={fieldName}
        index={index}
      />
    ) : (
      `Item ${index !== undefined ? `#${index + 1}` : ""}`
    );

    return (
      <div className="border rounded-lg">
        {isCollapsible && (
          <header
            className={cn(
              "flex items-center gap-x-2 rounded-t-lg pl-4 pr-1 h-8.5 text-sm font-medium hover:bg-muted transition-colors cursor-pointer",
              isOpen ? "" : "rounded-b-lg",
            )}
            onClick={onToggleOpen}
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-90" : "",
              )}
            />
            <span className={hasErrors() ? "text-destructive" : ""}>
              {itemLabel}
            </span>
          </header>
        )}
        <div
          className={cn(
            "p-4 grid gap-6",
            isCollapsible && "border-t",
            isOpen ? "" : "hidden",
          )}
        >
          {renderFields(
            field.fields || [],
            fieldName,
            registerBeforeSubmitHook,
            undefined,
            Boolean(field.readonly),
            keyPrefix,
          )}
        </div>
      </div>
    );
  },
);

ObjectField.displayName = "ObjectField";

const SingleField = ({
  field,
  fieldName,
  renderFields,
  registerBeforeSubmitHook,
  onChangeRegistered,
  showLabel = true,
  isOpen = true,
  toggleOpen = () => {},
  index = 0,
  keyPrefix,
}: {
  field: FieldWithReadonlyMeta;
  fieldName: string;
  renderFields: RenderFields;
  registerBeforeSubmitHook?: RegisterBeforeSubmitHook;
  onChangeRegistered?: () => void;
  showLabel?: boolean;
  isOpen?: boolean;
  toggleOpen?: () => void;
  index?: number;
  keyPrefix?: string;
}) => {
  const {
    control,
    formState: { errors },
  } = useFormContext();
  const isRichTextField = field.type === "rich-text";
  const showLabelSlot = isRichTextField && field.options?.switcher !== false;
  const shouldShowFieldMeta =
    showLabel && (field.label !== false || field.required || showLabelSlot);
  const rawLabelSlotId = useId();
  const labelSlotId = useMemo(
    () => `field-label-slot-${rawLabelSlotId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [rawLabelSlotId],
  );

  const isCollapsible = !!(
    field.list &&
    !(typeof field.list === "object" && field.list?.collapsible === false)
  );

  if (["object", "block"].includes(field.type)) {
    const hasErrors = () => hasFieldPathError(errors, fieldName);
    const NestedComponent = field.type === "block" ? BlocksField : ObjectField;

    return (
      <FormItem key={fieldName}>
        {shouldShowFieldMeta && (
          <div className="flex items-center h-5 gap-x-2">
            {field.label !== false && (
              <Label className={hasErrors() ? "text-destructive" : ""}>
                {field.label || field.name}
              </Label>
            )}
            {field.required && (
              <Badge variant="secondary" className="text-muted-foreground">
                <Asterisk className="-ml-1 -mr-0.5" />
                Required
              </Badge>
            )}
            {hasExplicitReadonly(field) && (
              <Badge variant="secondary" className="text-muted-foreground">
                <Ban className="-ml-0.5" />
                Readonly
              </Badge>
            )}
          </div>
        )}
        <NestedComponent
          field={field}
          fieldName={fieldName}
          keyPrefix={keyPrefix}
          renderFields={renderFields}
          registerBeforeSubmitHook={registerBeforeSubmitHook}
          isOpen={isOpen}
          onToggleOpen={isCollapsible ? toggleOpen : undefined}
          index={isCollapsible ? index : undefined}
        />
        {field.description && (
          <FormDescription>{field.description}</FormDescription>
        )}
      </FormItem>
    );
  } else {
    let FieldComponent;

    if (typeof field.type === "string" && editComponents[field.type]) {
      FieldComponent = editComponents[field.type];
    } else {
      console.warn(
        `No component found for field type: ${field.type}. Defaulting to 'text'.`,
      );
      FieldComponent = editComponents["text"];
    }

    return (
      <FormField
        name={fieldName}
        control={control}
        render={({ field: rhfManagedFieldProps }) => (
          <FormItem>
            {shouldShowFieldMeta && (
              <div className="flex items-center justify-between min-h-6 gap-x-2">
                <div className="flex items-center gap-x-2 min-w-0">
                  {field.label !== false && (
                    <FormLabel>{field.label || field.name}</FormLabel>
                  )}
                  {field.required && (
                    <Badge
                      variant="secondary"
                      className="text-muted-foreground"
                    >
                      <Asterisk className="-ml-1 -mr-0.5" />
                      Required
                    </Badge>
                  )}
                  {hasExplicitReadonly(field) && (
                    <Badge
                      variant="secondary"
                      className="text-muted-foreground"
                    >
                      <Ban className="-ml-0.5" />
                      Readonly
                    </Badge>
                  )}
                </div>
                {showLabelSlot && <div id={labelSlotId} className="shrink-0" />}
              </div>
            )}
            <FormControl>
              {(() => {
                const sharedProps = {
                  ...rhfManagedFieldProps,
                  field,
                };
                if (field.type === "rich-text") {
                  return (
                    <FieldComponent
                      {...sharedProps}
                      labelSlotId={showLabelSlot ? labelSlotId : undefined}
                      registerBeforeSubmitHook={registerBeforeSubmitHook}
                      onChangeRegistered={onChangeRegistered}
                    />
                  );
                }
                return <FieldComponent {...sharedProps} />;
              })()}
            </FormControl>
            {field.description && (
              <FormDescription>{field.description}</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
    );
  }
};

SingleField.displayName = "SingleField";

const EntryForm = ({
  fields,
  contentObject,
  onSubmit = () => {},
  filePath,
  onDirtyChange,
  onChangeRegistered,
}: {
  fields: Field[];
  contentObject?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => void;
  filePath?: React.ReactNode;
  onDirtyChange?: (isDirty: boolean) => void;
  onChangeRegistered?: () => void;
}) => {
  const zodSchema = useMemo(() => {
    return generateZodSchema(fields);
  }, [fields]);

  const defaultValues = useMemo(() => {
    return initializeState(fields, sanitizeObject(contentObject));
  }, [fields, contentObject]);

  const form = useForm({
    resolver: zodSchema && zodResolver(zodSchema),
    defaultValues,
    reValidateMode: "onSubmit",
  });

  useEffect(() => {
    form.reset(defaultValues);
  }, [defaultValues, form]);

  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);

  const beforeSubmitHooksRef = useRef<Map<string, BeforeSubmitHook>>(new Map());

  const registerBeforeSubmitHook = useCallback(
    (key: string, hook: BeforeSubmitHook) => {
      beforeSubmitHooksRef.current.set(key, hook);
      return () => {
        beforeSubmitHooksRef.current.delete(key);
      };
    },
    [],
  );

  const renderFields: RenderFields = useCallback(
    (
      fields: FieldWithReadonlyMeta[],
      parentName?: string,
      registerBeforeSubmitHook?: RegisterBeforeSubmitHook,
      runBeforeSubmitHooks?: () => Promise<void>,
      inheritedReadonly = false,
      keyPrefix?: string,
    ): React.ReactNode[] => {
      return fields.map((field) => {
        if (!field || field.hidden) return null;
        const effectiveField =
          inheritedReadonly && !field.readonly
            ? { ...field, readonly: true, __inheritedReadonly: true }
            : field;
        const currentFieldName = parentName
          ? `${parentName}.${effectiveField.name}`
          : effectiveField.name;
        const currentFieldKey = keyPrefix
          ? `${keyPrefix}.${effectiveField.name}`
          : currentFieldName;

        if (
          effectiveField.list === true ||
          (typeof effectiveField.list === "object" &&
            effectiveField.list !== null)
        ) {
          return (
            <ListField
              key={currentFieldKey}
              field={effectiveField}
              fieldName={currentFieldName}
              renderFields={renderFields}
              registerBeforeSubmitHook={registerBeforeSubmitHook}
              runBeforeSubmitHooks={runBeforeSubmitHooks}
            />
          );
        }
        return (
          <SingleField
            key={currentFieldKey}
            field={effectiveField}
            fieldName={currentFieldName}
            keyPrefix={currentFieldKey}
            renderFields={renderFields}
            registerBeforeSubmitHook={registerBeforeSubmitHook}
            onChangeRegistered={onChangeRegistered}
          />
        );
      });
    },
    [onChangeRegistered],
  );

  const runBeforeValidationHooks = useCallback(async () => {
    const hooks = Array.from(beforeSubmitHooksRef.current.values());
    for (const hook of hooks) {
      await hook();
    }
  }, []);

  const handleSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      const latestValues = form.getValues() as Record<string, unknown>;
      await onSubmit(latestValues);
    },
    [form, onSubmit],
  );

  const handleError = () => {
    toast.error("Please fix the errors before saving.", { duration: 5000 });
  };

  const handleFormSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await runBeforeValidationHooks();
      await form.handleSubmit(handleSubmit, handleError)(event);
    },
    [form, handleSubmit, runBeforeValidationHooks],
  );

  return (
    <Form {...form}>
      <form
        id="entry-form"
        onSubmit={handleFormSubmit}
        className="w-full max-w-screen-md mx-auto grid items-start gap-6"
      >
        {filePath && (
          <div className="space-y-2 overflow-hidden">
            <FormLabel>Filename</FormLabel>
            {filePath}
          </div>
        )}
        {renderFields(fields, undefined, registerBeforeSubmitHook, runBeforeValidationHooks)}
      </form>
    </Form>
  );
};

export { EntryForm };
