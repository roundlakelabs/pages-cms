"use client";

import { Thumbnail } from "@/components/thumbnail";
import { Field } from "@/types/field";
import { useConfig } from "@/contexts/config-context";
import { getColumns, getAspectRatio } from "./index";

// Rows shown in the collection list before collapsing the rest into "+N".
const PREVIEW_ROWS = 2;

const ViewComponent = ({
  value,
  field
}: {
  value: string | string[] | null;
  field: Field;
}) => {
  const { config } = useConfig();
  const mediaName = (field.options?.media as string) || config?.object.media?.[0]?.name;
  const columns = getColumns(field);
  const aspectRatio = getAspectRatio(field);

  const paths = (typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  if (paths.length === 0) return null;

  const visible = paths.slice(0, columns * PREVIEW_ROWS);
  const hiddenCount = paths.length - visible.length;

  return (
    <span className="flex items-end gap-x-1.5 py-1">
      <span
        className="grid gap-0.5 w-32 shrink-0"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {visible.map((path, index) => (
          <Thumbnail
            key={`${path}-${index}`}
            name={mediaName}
            path={path}
            className="aspect-auto rounded-[2px]"
            style={{ aspectRatio }}
          />
        ))}
      </span>
      {hiddenCount > 0 && (
        <span className="text-muted-foreground text-xs">
          +{hiddenCount}
        </span>
      )}
    </span>
  );
}

export { ViewComponent };
