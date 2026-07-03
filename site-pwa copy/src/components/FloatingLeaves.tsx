import React from "react";

import "./FloatingLeaves.css";
type Props = {};

const FloatingLeaves = (props: Props) => {
  return (
    <div className="nature-background">
      <div className="floating-leaf leaf-1"></div>
      <div className="floating-leaf leaf-2"></div>
      <div className="floating-leaf leaf-3"></div>
      <div className="floating-leaf leaf-4"></div>
    </div>
  );
};

export default FloatingLeaves;
