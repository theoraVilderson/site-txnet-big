import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhoneField } from './PhoneField';

function renderField() {
  return render(
    <div dir="rtl">
      <PhoneField
        id="phone"
        label="شماره موبایل"
        value=""
        onChange={() => undefined}
        lang="fa"
        countryLabel="کشور"
        searchLabel="جستجو"
        noResultsLabel="یافت نشد"
      />
    </div>,
  );
}

describe('PhoneField on a right-to-left page', () => {
  // A phone number reads left to right (`+98 912 …`) in every language, so
  // the country code sits on its left even when the page is Persian. In an
  // RTL row the first child is drawn on the right, which put the code after
  // the number.
  it('lays the country code and the number out left to right', () => {
    renderField();
    const country = screen.getByRole('button', { name: 'کشور' });
    const number = screen.getByLabelText('شماره موبایل');
    const row = country.parentElement!;

    expect(row.getAttribute('dir')).toBe('ltr');
    expect(row.contains(number)).toBe(true);
    expect(
      country.compareDocumentPosition(number) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves the field's own direction to the page, so the label keeps its side", () => {
    // `[dir="ltr"] .organic-field label` moves the label left; it must only
    // match the page's direction, never this row's.
    const { container } = renderField();
    expect(container.querySelector('.organic-field')!.closest('[dir="ltr"]')).toBeNull();
  });
});
