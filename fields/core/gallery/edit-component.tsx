"use client";

import { forwardRef, useCallback, useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { MediaUpload } from "@/components/media/media-upload";
import { MediaDialog } from "@/components/media/media-dialog";
import { Upload, FolderOpen } from "lucide-react";
import { useConfig } from "@/contexts/config-context";
import { normalizeMediaPath, normalizePath } from "@/lib/utils/file";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getSchemaByName } from "@/lib/schema";
import { Thumbnail } from "@/components/thumbnail";
import { ImageTeaser } from "@/fields/core/image/edit-component";
import { getAllowedExtensions } from "@/fields/core/image";
import { getColumns } from "./index";
import type { Config } from "@/types/config";
import type { Field } from "@/types/field";
import type { FileSaveData } from "@/types/api";

const generateId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

type FileEntry = {
  id: string;
  path: string;
};

type MediaSchema = {
  name: string;
  input: string;
  extensions?: string[];
  rename?: boolean | "safe" | "random";
};

type EditorProps = {
  value?: string | string[] | null;
  field: Field;
  onChange: (value: string[]) => void;
};

type FieldOptions = {
  media?: false | string;
  path?: string;
  columns?: number;
  max?: number;
  rename?: boolean | "safe" | "random";
};

const GalleryCell = ({ id, file, index, config, media, onRemove, readonly = false }: {
  id: string;
  file: string;
  index: number;
  config: Pick<Config, "owner" | "repo" | "branch">;
  media: string;
  onRemove?: () => void;
  readonly?: boolean;
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const
  };

  return (
    <div ref={setNodeRef} style={style} className="aspect-square min-w-0">
      <div title={file} className={readonly ? "h-full" : "h-full cursor-move"} {...(!readonly ? attributes : {})} {...(!readonly ? listeners : {})}>
        <Thumbnail name={media} path={file} className="rounded-md w-full h-full"/>
      </div>
      <span className="absolute top-1 left-1 rounded bg-background/95 px-1.5 text-xs text-muted-foreground tabular-nums backdrop-blur-sm">
        {index + 1}
      </span>
      <ImageTeaser file={file} config={config} onRemove={onRemove} />
    </div>
  );
};

const EditComponent = forwardRef((props: EditorProps, ref: React.Ref<HTMLInputElement>) => {
  const { value, field, onChange } = props;
  void ref;
  const { config } = useConfig();
  if (!config) throw new Error("Configuration not found.");
  const options = (field.options ?? {}) as FieldOptions;
  const isReadonly = Boolean(field.readonly);
  const columns = getColumns(field);

  const [files, setFiles] = useState<FileEntry[]>(() => {
    const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    return paths
      .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      .map((path) => ({ id: generateId(), path: normalizeMediaPath(path) }));
  });

  const mediaConfig = useMemo<MediaSchema | undefined>(() => {
    return (config.object?.media?.length && options.media !== false)
      ? options.media && typeof options.media === 'string'
        ? getSchemaByName(config.object, options.media, "media") as MediaSchema | undefined
        : config.object.media[0] as MediaSchema
      : undefined;
  }, [config.object, options.media]);

  const rootPath = useMemo(() => {
    if (!options.path) {
      return mediaConfig?.input;
    }

    const mediaRoot = mediaConfig?.input;
    if (!mediaRoot) {
      return normalizePath(options.path);
    }

    const normalizedPath = normalizePath(options.path);
    const normalizedMediaPath = normalizePath(mediaRoot);

    if (!normalizedPath.startsWith(normalizedMediaPath)) {
      console.warn(`"${options.path}" is not within media root "${mediaRoot}". Defaulting to media root.`);
      return mediaRoot;
    }

    return normalizedPath;
  }, [options.path, mediaConfig?.input]);

  const allowedExtensions = useMemo(() => {
    if (!mediaConfig) return [];
    return getAllowedExtensions(field, mediaConfig);
  }, [field, mediaConfig]);

  const maxFiles = typeof options.max === "number" ? options.max : undefined;
  const remainingSlots = (maxFiles ?? Infinity) - files.length;

  // Pad the last row with placeholders so the grid shape matches the site.
  const placeholderCount = files.length % columns === 0 ? 0 : columns - (files.length % columns);

  useEffect(() => {
    onChange(files.map(f => f.path));
  }, [files, onChange]);

  const appendPaths = useCallback((paths: string[]) => {
    setFiles((prev) => {
      const next = [
        ...prev,
        ...paths.map((path) => ({ id: generateId(), path: normalizeMediaPath(path) })),
      ];
      if (typeof maxFiles !== "number") return next;
      return next.slice(0, maxFiles);
    });
  }, [maxFiles]);

  const handleUpload = useCallback((fileData: FileSaveData) => {
    if (!fileData.path) return;
    appendPaths([fileData.path]);
  }, [appendPaths]);

  const handleRemove = useCallback((fileId: string) => {
    setFiles(prev => prev.filter(file => file.id !== fileId));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (isReadonly) return;
    const { active, over } = event;
    if (!over) return;

    if (active.id !== over.id) {
      setFiles((items) => {
        const oldIndex = items.findIndex(item => item.id === active.id);
        const newIndex = items.findIndex(item => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  if (!mediaConfig) {
    return (
      <p className="text-muted-foreground bg-muted rounded-md px-3 py-2">
      No media configuration found. {' '}
      <a
        href={`/${config.owner}/${config.repo}/${encodeURIComponent(config.branch || "")}/settings`}
        className="underline hover:text-foreground"
      >
        Check your settings
      </a>.
    </p>
    );
  }

  return (
    <MediaUpload
      path={rootPath}
      media={mediaConfig.name}
      extensions={allowedExtensions || undefined}
      onUpload={handleUpload}
      multiple
      rename={options.rename ?? mediaConfig.rename}
      disabled={isReadonly}
    >
      <MediaUpload.DropZone>
        <div className="space-y-2">
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={files.map(f => f.id)}
                strategy={rectSortingStrategy}
              >
                {files.map((file, index) => (
                  <GalleryCell
                    key={file.id}
                    id={file.id}
                    file={file.path}
                    index={index}
                    config={config}
                    media={mediaConfig.name}
                    onRemove={isReadonly ? undefined : () => handleRemove(file.id)}
                    readonly={isReadonly}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {Array.from({ length: files.length === 0 ? columns : placeholderCount }, (_, i) => (
              <div key={`placeholder-${i}`} className="aspect-square rounded-md border border-dashed" />
            ))}
          </div>
          {!isReadonly && remainingSlots > 0 && (
            <div className="flex gap-2">
              <MediaUpload.Trigger>
                <Button type="button" size="sm" variant="outline" className="gap-2">
                  <Upload className="h-3.5 w-3.5"/>
                  Upload
                </Button>
              </MediaUpload.Trigger>
              <MediaDialog
                media={mediaConfig.name}
                initialPath={rootPath}
                maxSelected={Number.isFinite(remainingSlots) ? remainingSlots : undefined}
                extensions={allowedExtensions}
                onSubmit={appendPaths}
              >
                <Button type="button" size="sm" variant="outline">
                  <FolderOpen />
                  Select
                </Button>
              </MediaDialog>
            </div>
          )}
        </div>
      </MediaUpload.DropZone>
    </MediaUpload>
  );
});

EditComponent.displayName = "EditComponent";

export { EditComponent };
