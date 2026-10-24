import { z } from 'zod';

/** Variable keys must survive a shell and a .env file. */
export const variableKey = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Use letters, digits and underscores; start with a letter or _',
  );

export const variableSchema = z.object({
  key: variableKey,
  value: z.string().max(8192),
  isSecret: z.boolean().default(true),
});

export const variableListSchema = z.object({
  variables: z.array(variableSchema).max(200),
});

export const targetSchema = z.string().min(1);
