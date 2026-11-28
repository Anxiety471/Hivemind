/**
 * A small, bounded XML reader for office document parts. It builds an element tree and
 * decodes the five predefined entities plus numeric references. It never fetches anything,
 * never expands entities, and rejects any DTD, so an XML part cannot reach outside itself.
 */

export type XmlElement = {
  /** Qualified name as written, e.g. "w:p". */
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlElement | string>;
};

/** Deeper nesting than any office part uses; a deeper part is treated as corrupt. */
const MAX_DEPTH = 96;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** The part of a qualified name after its prefix, so "w:p" and "p" compare equal. */
export function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    attributes[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/**
 * Parses one XML document into its root element, or returns null when the text is not
 * well-formed for our purposes (mismatched tags, a DTD, or nesting past MAX_DEPTH).
 */
export function parseXmlTree(xml: string): XmlElement | null {
  const root: XmlElement = { name: "#document", attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open === -1) {
      appendText(stack, xml.slice(index));
      break;
    }
    if (open > index) appendText(stack, xml.slice(index, open));
    index = open;
    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end === -1) return null;
      index = end + 3;
    } else if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end === -1) return null;
      appendRaw(stack, xml.slice(index + 9, end));
      index = end + 3;
    } else if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end === -1) return null;
      index = end + 2;
    } else if (xml.startsWith("<!", index)) {
      // DOCTYPE and entity declarations are how entity expansion attacks arrive; refuse them.
      return null;
    } else if (xml.startsWith("</", index)) {
      const end = xml.indexOf(">", index);
      if (end === -1) return null;
      const name = xml.slice(index + 2, end).trim();
      const current = stack.pop();
      if (!current || stack.length === 0 || current.name !== name) return null;
      index = end + 1;
    } else {
      const end = findTagEnd(xml, index);
      if (end === -1) return null;
      const raw = xml.slice(index + 1, end);
      const selfClosing = raw.endsWith("/");
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameEnd = body.search(/[\s/]/);
      const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
      if (!name) return null;
      const element: XmlElement = {
        name,
        attributes: parseAttributes(nameEnd === -1 ? "" : body.slice(nameEnd)),
        children: [],
      };
      const parent = stack[stack.length - 1]!;
      parent.children.push(element);
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) return null;
        stack.push(element);
      }
      index = end + 1;
    }
  }
  if (stack.length !== 1) return null;
  const elements = root.children.filter((child): child is XmlElement => typeof child !== "string");
  return elements.length === 1 ? elements[0]! : null;
}

/** The index of the ">" that closes a start tag, skipping any ">" inside a quoted attribute. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function appendText(stack: XmlElement[], raw: string): void {
  appendRaw(stack, decodeXmlEntities(raw));
}

function appendRaw(stack: XmlElement[], text: string): void {
  if (!text) return;
  stack[stack.length - 1]!.children.push(text);
}

/** The text of an element and everything below it, in document order. */
export function textOf(element: XmlElement): string {
  let out = "";
  for (const child of element.children) {
    out += typeof child === "string" ? child : textOf(child);
  }
  return out;
}

/** The direct child elements with this local name. */
export function childElements(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== "string" && localName(child.name) === local,
  );
}

/** Every descendant element with this local name, in document order (not including `element`). */
export function descendantElements(element: XmlElement, local: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      if (localName(child.name) === local) found.push(child);
      visit(child);
    }
  };
  visit(element);
  return found;
}

/** The attribute whose local name matches, e.g. "val" matches "w:val". */
export function attributeNamed(element: XmlElement, local: string): string | undefined {
  for (const [key, value] of Object.entries(element.attributes)) {
    if (localName(key) === local) return value;
  }
  return undefined;
}
