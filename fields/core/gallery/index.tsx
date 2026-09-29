import { ViewComponent } from "./view-component";
import { EditComponent } from "./edit-component";
import { Field } from "@/types/field";
import * as imageField from "@/fields/core/image";

const DEFAULT_COLUMNS = 3;
const MAX_COLUMNS = 12;

// A gallery is an ordered list of images, so we reuse the image field logic
// (read/write path swapping, validation) with `multiple` always enabled.
const toImageField = (field: Field): Field => {
  const max = typeof field.options?.max === "number" ? field.options.max : undefined;
  return {
    ...field,
    options: {
      ...field.options,
      multiple: max ? { max } : true,
    },
  };
};

const getColumns = (field: Field): number => {
  const columns = Number(field.options?.columns);
  if (!Number.isInteger(columns) || columns < 1) return DEFAULT_COLUMNS;
  return Math.min(columns, MAX_COLUMNS);
};

const read = (value: any, field: Field, config: Record<string, any>) => {
  if (typeof value === "string") value = [value];
  return imageField.read(value, toImageField(field), config);
};

const write = (value: any, field: Field, config: Record<string, any>) => {
  const result = imageField.write(value, toImageField(field), config);
  return result ?? [];
};

const schema = (field: Field, configObject?: Record<string, any>) => {
  return imageField.schema(toImageField(field), configObject);
};

const defaultValue = () => [];

const label = "Gallery";

export { label, schema, ViewComponent, EditComponent, read, write, defaultValue, toImageField, getColumns };
