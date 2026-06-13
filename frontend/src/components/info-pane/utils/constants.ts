// ── Constants ──

export const INDENT = 12

export const MONTHS_DE: Record<string, string> = {
  '01': 'Januar', '02': 'Februar', '03': 'Maerz', '04': 'April',
  '05': 'Mai', '06': 'Juni', '07': 'Juli', '08': 'August',
  '09': 'September', '10': 'Oktober', '11': 'November', '12': 'Dezember'
}

export const WEEKDAY_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

export const MD = "font-[var(--font-heading)] text-[15px] leading-[1.75] text-[var(--t2)] [&>*:first-child]:mt-0 [&_h1]:font-[var(--font-body)] [&_h1]:text-[19px] [&_h1]:font-semibold [&_h1]:text-[var(--t1)] [&_h1]:mb-2.5 [&_h1]:mt-5 [&_h2]:font-[var(--font-body)] [&_h2]:text-[16.5px] [&_h2]:font-semibold [&_h2]:text-[var(--t1)] [&_h2]:mb-2 [&_h2]:mt-5 [&_h3]:font-[var(--font-body)] [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-[var(--t1)] [&_h3]:mb-1.5 [&_h3]:mt-4 [&_p]:my-2.5 [&_strong]:font-semibold [&_strong]:text-[var(--t1)] [&_ul]:pl-5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ol]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_li]:my-1 [&_li]:pl-1 [&_li]:marker:text-[var(--t3)] [&_a]:text-[var(--cc-orange)] [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border)] [&_blockquote]:pl-3 [&_blockquote]:my-3 [&_blockquote]:text-[var(--t3)] [&_code]:font-mono [&_code]:text-[13px] [&_code]:bg-[var(--bg-2)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-[var(--bg-2)] [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:border-[var(--border)] [&_hr]:my-4 [&_em]:text-[var(--t3)] [&_table]:my-3 [&_table]:w-full [&_th]:text-left [&_th]:font-semibold [&_th]:text-[var(--t1)] [&_th]:border-b [&_th]:border-[var(--border)] [&_th]:py-1.5 [&_th]:pr-3 [&_td]:py-1.5 [&_td]:pr-3 [&_td]:align-top"

// Kurz-Aliase fuer Neben-Agenten. 'main' und 'claude' fehlen bewusst: dort faellt
// der Aufrufer auf den Laufzeit-Namen aus config/agents.json zurueck (ag.name).
export const SHORT_NAMES: Record<string, string> = {
  eva: 'System', alex: 'Content', wolf: 'Signals',
}

export const HIDDEN_FOLDERS = new Set(['.git', '.venv', 'node_modules', '__pycache__', '.DS_Store', 'dist', '.next', '.claude'])
