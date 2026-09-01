import React from 'react';

export const OrganicField = ({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder = " ",
  dir = "auto",
}: any) => (
  <div className="organic-field">
    <div className="field-nature" />
    <input
      type={type}
      id={id}
      name={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={dir === "ltr" ? "dir-ltr text-left font-mono" : ""}
    />
    <label htmlFor={id}>{label}</label>
  </div>
);
