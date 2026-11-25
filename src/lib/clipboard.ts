export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback to execCommand if clipboard permissions are restricted
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'fixed -top-full -left-full opacity-0 pointer-events-none';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}
