import React from "react";
import AuthForm, { AuthFormProps } from "./AuthForm";
import Box from "@mui/material/Box";
type Props = {};

function Auth({ type }: AuthFormProps) {
  return (
    <Box component="section" className="justify-center flex w-full  box-border">
      <AuthForm type={type} />
    </Box>
  );
}

export default Auth;
