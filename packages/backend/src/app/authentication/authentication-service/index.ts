import { QueryFailedError } from 'typeorm'
import { AuthenticationResponse, UserStatus, ActivepiecesError, ErrorCode, isNil, User, ApFlagId, Project, TelemetryEventName, UserId } from '@activepieces/shared'
import { userService } from '../../user/user-service'
import { passwordHasher } from '../lib/password-hasher'
import { authenticationServiceHooks as hooks } from './hooks'
import { generateRandomPassword } from '../../helper/crypto'
import { flagService } from '../../flags/flag.service'
import { system } from '../../helper/system/system'
import { SystemProp } from '../../helper/system/system-prop'
import { logger } from '../../helper/logger'
import { telemetry } from '../../helper/telemetry.utils'

const SIGN_UP_ENABLED = system.getBoolean(SystemProp.SIGN_UP_ENABLED) ?? false

export const authenticationService = {
    async signUp(params: SignUpParams): Promise<AuthenticationResponse> {
        await assertSignUpIsEnabled(params)
        const user = await createUser(params)

        return this.signUpResponse({
            user,
            referringUserId: params.referringUserId,
        })
    },

    async signIn(request: SignInParams): Promise<AuthenticationResponse> {
        const user = await userService.getByPlatformAndEmail({
            platformId: request.platformId,
            email: request.email,
        })

        assertUserIsAllowedToSignIn(user)

        await assertPasswordMatches({
            requestPassword: request.password,
            userPassword: user.password,
        })


        return this.signInResponse({
            user,
        })
    },

    async federatedAuthn(params: FederatedAuthnParams): Promise<AuthenticationResponse> {
        const existingUser = await userService.getByPlatformAndEmail({
            platformId: params.platformId,
            email: params.email,
        })

        if (existingUser) {
            return this.signInResponse({
                user: existingUser,
            })
        }

        const newUser = {
            email: params.email,
            status: params.userStatus,
            firstName: params.firstName,
            lastName: params.lastName,
            trackEvents: true,
            newsLetter: true,
            password: await generateRandomPassword(),
            platformId: params.platformId,
        }

        return this.signUp(newUser)
    },

    async signUpResponse({ user, referringUserId }: SignUpResponseParams): Promise<AuthenticationResponse> {
        const authnResponse = await hooks.get().postSignUp({
            user,
            referringUserId,
        })

        const userWithoutPassword = removePasswordPropFromUser(authnResponse.user)

        await sendTelemetry({
            user, project: authnResponse.project,
        })

        return {
            ...userWithoutPassword,
            token: authnResponse.token,
            projectId: authnResponse.project.id,
        }
    },

    async signInResponse({ user }: SignInResponseParams): Promise<AuthenticationResponse> {
        const authnResponse = await hooks.get().postSignIn({
            user,
        })

        const userWithoutPassword = removePasswordPropFromUser(authnResponse.user)

        return {
            ...userWithoutPassword,
            token: authnResponse.token,
            projectId: authnResponse.project.id,
        }
    },
}

const assertSignUpIsEnabled = async (params: SignUpParams): Promise<void> => {
    const userCreated = await flagService.getOne(ApFlagId.USER_CREATED)

    if (userCreated && !SIGN_UP_ENABLED) {
        throw new ActivepiecesError({
            code: ErrorCode.SIGN_UP_DISABLED,
            params: {},
        })
    }

    await enablePlatformSignUpForInvitedUsersOnly(params)
}

const createUser = async (params: SignUpParams): Promise<User> => {
    try {
        const newUser: NewUser = {
            email: params.email,
            status: params.status,
            firstName: params.firstName,
            lastName: params.lastName,
            trackEvents: params.trackEvents,
            newsLetter: params.newsLetter,
            password: params.password,
            platformId: params.platformId,
        }

        return await userService.create(newUser)
    }
    catch (e: unknown) {
        if (e instanceof QueryFailedError) {
            throw new ActivepiecesError({
                code: ErrorCode.EXISTING_USER,
                params: {
                    email: params.email,
                    platformId: params.platformId,
                },
            })
        }

        throw e
    }
}

const enablePlatformSignUpForInvitedUsersOnly = async (params: SignUpParams): Promise<void> => {
    if (params.platformId) {
        throw new ActivepiecesError({
            code: ErrorCode.PLATFORM_SIGN_UP_ENABLED_FOR_INVITED_USERS_ONLY,
            params: {},
        })
    }
}

const assertUserIsAllowedToSignIn: (user: User | null) => asserts user is User = (user) => {
    if (isNil(user)) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_CREDENTIALS,
            params: null,
        })
    }

    if (user.status !== UserStatus.VERIFIED) {
        throw new ActivepiecesError({
            code: ErrorCode.EMAIL_IS_NOT_VERIFIED,
            params: {
                email: user.email,
            },
        })
    }
}

const assertPasswordMatches = async ({ requestPassword, userPassword }: AssertPasswordsMatchParams): Promise<void> => {
    const passwordMatches = await passwordHasher.compare(requestPassword, userPassword)

    if (!passwordMatches) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_CREDENTIALS,
            params: null,
        })
    }
}

const removePasswordPropFromUser = (user: User): Omit<User, 'password'> => {
    const { password: _, ...filteredUser } = user
    return filteredUser
}

const sendTelemetry = async ({ user, project }: SendTelemetryParams): Promise<void> => {
    try {
        await telemetry.identify(user, project.id)

        await telemetry.trackProject(project.id, {
            name: TelemetryEventName.SIGNED_UP,
            payload: {
                userId: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                projectId: project.id,
            },
        })
    }
    catch (e) {
        logger.warn({ name: 'AuthenticationService#sendTelemetry', error: e })
    }
}

type SendTelemetryParams = {
    user: User
    project: Project
}



type NewUser = Omit<User, 'id' | 'created' | 'updated'>

type SignUpParams = {
    email: string
    password: string
    firstName: string
    lastName: string
    trackEvents: boolean
    newsLetter: boolean
    status: UserStatus
    platformId: string | null
    referringUserId?: string
}

type SignInParams = {
    email: string
    password: string
    platformId: string | null
}

type AssertPasswordsMatchParams = {
    requestPassword: string
    userPassword: string
}

type FederatedAuthnParams = {
    email: string
    userStatus: UserStatus
    firstName: string
    lastName: string
    platformId: string | null
}

type SignUpResponseParams = {
    user: User
    referringUserId?: UserId
}

type SignInResponseParams = {
    user: User
}
