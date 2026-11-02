// Таблица inode: стабильные номера и жёсткие ссылки.
// InMemoryFs из just-bash держит жёсткую ссылку как копию-снимок (после записи через одно имя второе
// не меняется), поэтому группу имён одного inode ведём сами, а содержимое синхронизирует охраняемая ФС.
import { normalize } from "./path";

export class InodeTable {
  private byPath = new Map<string, number>();
  private byIno = new Map<number, Set<string>>();
  private next = 50331777; // как на корневой xfs свежего сервера

  /** Выдать номер (если у пути его ещё нет). */
  ino(path: string): number {
    const p = normalize(path);
    let n = this.byPath.get(p);
    if (n === undefined) {
      n = this.next;
      this.next += 1 + ((n * 7) % 5);
      this.attach(p, n);
    }
    return n;
  }

  private attach(p: string, n: number): void {
    this.byPath.set(p, n);
    let s = this.byIno.get(n);
    if (!s) this.byIno.set(n, (s = new Set()));
    s.add(p);
  }

  /** Новый объект: свежий inode (старое имя пути забывается). */
  create(path: string): number {
    const p = normalize(path);
    this.forget(p);
    return this.ino(p);
  }

  /** Жёсткая ссылка: новое имя получает inode существующего. */
  link(existing: string, np: string): void {
    const n = this.ino(existing);
    const p = normalize(np);
    this.forget(p);
    this.attach(p, n);
  }

  /** Имя удалено. */
  forget(path: string): void {
    const p = normalize(path);
    const n = this.byPath.get(p);
    if (n === undefined) return;
    this.byPath.delete(p);
    const s = this.byIno.get(n);
    s?.delete(p);
    if (s && !s.size) this.byIno.delete(n);
  }

  /** Удалено поддерево (rm -r). */
  forgetTree(path: string): void {
    const p = normalize(path);
    const prefix = p === "/" ? "/" : p + "/";
    for (const k of [...this.byPath.keys()]) if (k === p || k.startsWith(prefix)) this.forget(k);
  }

  /** Переименование (inode переезжает вместе с именем). */
  rename(from: string, to: string): void {
    const f = normalize(from);
    const t = normalize(to);
    const prefix = f + "/";
    this.forget(t);
    for (const [k, n] of [...this.byPath]) {
      if (k === f || k.startsWith(prefix)) {
        this.forget(k);
        this.attach(t + k.slice(f.length), n);
      }
    }
  }

  /** Все имена того же inode (включая само). */
  names(path: string): string[] {
    const n = this.ino(path);
    return [...(this.byIno.get(n) ?? [])];
  }

  /** Число жёстких ссылок на файл. */
  count(path: string): number {
    return this.names(path).length;
  }

  sameFile(a: string, b: string): boolean {
    return this.ino(a) === this.ino(b);
  }
}
