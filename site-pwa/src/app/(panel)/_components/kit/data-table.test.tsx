import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { DataTable, type DataColumn } from "./DataTable";

/**
 * The kit `DataTable` (UX-1-g, `contract.ux.md` K13). Both layouts are in the
 * document and CSS shows one (the table from `md`, cards below it), so what
 * this asserts is each layout's content and wiring:
 *
 * - a card is titled by the first column and lists at most four more, label :
 *   value, never a column without a header (the actions);
 * - a row's actions are one `Menu`, in the table and on the card alike;
 * - a sortable header says its order (`aria-sort`) and asks the page to sort;
 * - ticking rows shows the bulk bar with the count; the header box ticks all.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({
    lang: "en",
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars?.count !== undefined ? `${key}:${vars.count}` : key),
  } as unknown as ReturnType<typeof useLocale>);
});

type Row = { id: string; name: string; a: string; b: string; c: string; d: string; e: string };
const ROWS: Row[] = [
  { id: "1", name: "First", a: "A1", b: "B1", c: "C1", d: "D1", e: "E1" },
  { id: "2", name: "Second", a: "A2", b: "B2", c: "C2", d: "D2", e: "E2" },
];
const COLUMNS: DataColumn<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, sortable: true },
  { id: "a", header: "Col A", cell: (r) => r.a },
  { id: "b", header: "Col B", cell: (r) => r.b },
  { id: "c", header: "Col C", cell: (r) => r.c },
  { id: "d", header: "Col D", cell: (r) => r.d },
  { id: "e", header: "Col E", cell: (r) => r.e },
];

const cards = () => screen.getAllByRole("listitem");
const table = () => screen.getByRole("table");

describe("DataTable", () => {
  it("draws every column in the table", () => {
    render(<DataTable label="Things" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />);
    const headers = within(table()).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Col A", "Col B", "Col C", "Col D", "Col E"]);
    expect(within(table()).getAllByRole("row")).toHaveLength(3);
    expect(within(table()).getByText("E2")).toBeInTheDocument();
  });

  it("titles a card by the first column and lists four more, label : value", () => {
    render(<DataTable label="Things" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />);
    const card = cards()[0];
    expect(within(card).getByRole("heading", { name: "First" })).toBeInTheDocument();
    const labels = within(card).getAllByRole("term").map((t) => t.textContent);
    expect(labels).toEqual(["Col A", "Col B", "Col C", "Col D"]);
    expect(within(card).getByText("D1")).toBeInTheDocument();
    expect(within(card).queryByText("E1")).not.toBeInTheDocument();
  });

  it("puts a row's actions in one menu, in the table and on the card", () => {
    const edit = vi.fn();
    render(
      <DataTable
        label="Things"
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        actions={(r) => [{ id: "edit", label: `Edit ${r.name}`, onSelect: () => edit(r.id) }]}
      />,
    );
    const inTable = within(table()).getAllByRole("button", { name: "kit.table.actions" });
    expect(inTable).toHaveLength(2);
    fireEvent.click(inTable[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Second" }));
    expect(edit).toHaveBeenCalledWith("2");

    const onCard = within(cards()[0]).getByRole("button", { name: "kit.table.actions" });
    fireEvent.click(onCard);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit First" }));
    expect(edit).toHaveBeenLastCalledWith("1");
  });

  it("says a sortable column's order and asks the page to sort", () => {
    const onSort = vi.fn();
    render(<DataTable label="Things" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} sort={{ column: "name", direction: "desc" }} onSort={onSort} />);
    const header = within(table()).getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(within(table()).getByRole("columnheader", { name: "Col A" })).not.toHaveAttribute("aria-sort");
    fireEvent.click(within(header).getByRole("button"));
    expect(onSort).toHaveBeenCalledWith("name");
  });

  it("shows the bulk bar with the count once rows are ticked, and ticks all from the header", async () => {
    function Harness() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <DataTable
          label="Things"
          rows={ROWS}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          selection={{ selected, onChange: setSelected, actions: <button>Retire</button> }}
        />
      );
    }
    render(<Harness />);
    expect(screen.queryByRole("region", { name: /kit.table.selected/ })).not.toBeInTheDocument();
    fireEvent.click(within(table()).getAllByRole("checkbox", { name: "kit.table.selectRow" })[0]);
    const bar = screen.getByRole("region", { name: "kit.table.selected:1" });
    expect(within(bar).getByRole("button", { name: "Retire" })).toBeInTheDocument();

    fireEvent.click(within(table()).getByRole("checkbox", { name: "kit.table.selectAll" }));
    expect(screen.getByRole("region", { name: "kit.table.selected:2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "kit.table.clear" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /kit.table.selected/ })).not.toBeInTheDocument());
  });

  it("shows its empty state instead of an empty table", () => {
    render(<DataTable label="Things" rows={[]} columns={COLUMNS} rowKey={(r) => r.id} empty={<p>Nothing yet</p>} />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
