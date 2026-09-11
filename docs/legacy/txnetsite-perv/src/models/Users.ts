import { Permissions } from "@/types/permission";
import { IUserSchema, UserRoles, IUserStatus } from "@/types/user";
import mongoose, { Schema, model, models, Document } from "mongoose";

/**
 * User Schema
 */
const UserSchema = new Schema<IUserSchema>(
  {
    fullName: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    telegramID: {
      type: String,
      default: "",
    },
    walletBalance: {
      required: true,
      type: Number,
      default: 0,
    },
    roles: {
      required: true,
      type: [String],
      enum: Object.values(UserRoles),
      default: [UserRoles.USER],
    },
    permissions: {
      required: true,
      type: [String],
      enum: Object.values(Permissions),
      default: [],
    },
    status: {
      required: true,
      type: String,
      enum: Object.values(IUserStatus),
      default: IUserStatus.ACTIVE,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * User Model
 */
const Users =
  (models.User as mongoose.Model<IUserSchema, {}>) ||
  model<IUserSchema>("User", UserSchema);

export default Users;
