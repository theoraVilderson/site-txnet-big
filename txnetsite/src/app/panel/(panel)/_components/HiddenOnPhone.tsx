import React from "react";

type Props = { children: React.ReactNode };

export const HiddenOnPhone = ({ children }: Props) => {
  return <div className="hidden sm:flex">{children}</div>;
};
export const HiddenOnBiggerPhone = ({ children }: Props) => {
  return <div className="flex sm:hidden">{children}</div>;
};
