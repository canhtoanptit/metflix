/**
 * DEVELOPMENT ONLY. Key material published on purpose, like every other development default in
 * this repository: the development issuer must sign identically in every process, replica and
 * Workers isolate of a local mode without any setup, and anyone who can reach it can already
 * sign in as any persona. Never trust these keys anywhere else; `createDevIdp` refuses to run
 * in production. Generated once with Web Crypto (RSA 2048 for RS256, P-256 for ES256); `kid` is
 * the RFC 7638 thumbprint.
 */
import type { PrivateSigningJwk } from "./jose.ts";

/** One set per profile, so the default issuers do not share keys: RS256 current and next, ES256 current and next. */
export const DEVELOPMENT_KEY_SETS = {
  generic: [
    {
      kid: "y3-Rfyi2Zk3ei0roDR8DFKZVamKWZlLHxW2ggWvIh-8",
      alg: "RS256",
      kty: "RSA",
      n: "1NzZfEaEc1n_g2AvMzs6gh0bqqJ2m651ukF_HMHu_4kqpDWMT4Tw-iRTpVPWt_9cUwFEukwmFm7tpXrMW5jLEmveDXsUaSM3HNrfhGYULnx1ex9PkyVUsKJbOoBMdxYRUAUDcAGa4iHw1TvJWY3iXk37-NOcYdp7tn2mlxhzttci5rBAmkGOGVXBR8bMSrYbBrmvtT8E4ihUUkVbMfaLSAe4BtBtUJpY1GEWsYDLlVJ90kb6gGbA1N5aK5dpZxtWVeWy_PPDCLjoP7XHaka9yGhS1IeNBIkAA4-cIB4ECW9ZtSRRyQRb7HceSBhEYbt9l4hrpNLUwWioWgBRV3P4Lw",
      e: "AQAB",
      d: "qBkVpzleX7ndjmI8OWO3ULQBT-n8wJ-FWRFgJdWrvSEVYO2TYI4bv26bSnRq8eM3haqlcSRcRQWqUS7TM4Kg28CoxadCTG-tlkaX58wKeVYlcJXJbD_kIZlqx0g1GoDS1d51AymWpqh8XT2u7zSdD4bboCTR2nTaPcNR9lXZC7RoYGyiC9orTevSgKrJCk5Wske1EyYXQPuLGygRPnQQltd-JNL2xWWh3dSLz5CjATjw1akqp6KSzw8DpMukfNlcy2QD7fhjwlbHJfJ5qV3GGUObU2zlYHG9nHxyTPJzjxA25dianCS9wOHeny6q0OyCorBhE6lTR3wE9o6VJMm5",
      p: "91bRlIv1bhBpiSdzEyLbRxAJFd6X2UP653YmHers93Y1h5jhoK72IVrMrJvHJ4AKrSQQX14iUfbuUX6f6imRSwfZK_WAsfuUyI2bnROVSB0JPcTO2rGvIMaXhdSDUqP4-dA9v8bm0S81x3Tq9rK3m6T6cVfGejcVAA_9i-lzohk",
      q: "3FD6uqe_S4X1jlR4FLLRsftkvvSXw-fzbtuoaU0hqvsX8SIwFmCaoYJHtDHdX9OcuZqrGjThKbbwDAHWbBk_8gIsbOA2g5IFr6Vdi0hU5E1oUbqg_UjsS6VceOnQMNx5Z8CGHp8INCEilN4V7uzyleU3pBF7Rvz0hOZMynOnBYc",
      dp: "H_hJ2LCKhbJ7Ya4GsseDnljVQ81kxUGDMd3UqXNPM-FEpAU_zLwwtjj9UaZFBLcJKj4KG7mYKA4J2eDLHMJItHEMQiFWhCrnnVCod5IrbonKQwCoWB41a8Afn73LR6hIK0oeYSZ9eTZn9iMHp-GL2ANoF7RnxC5QeZSXijkfqCk",
      dq: "jtvzuRUM9evnTmN3efR6BO7-ZNQ1lNLTBw9oJN_e9P_chn-krt31ZsUTucSbx4dwGOoyCMxBNMtq3F5Uq8Ozszm1lOPOdYI6LasM_UPpyCBphJV_zr16e5K-Y6k5VnWgQ6aTUUfOCf9ybRWVI1iB9LCtY7XyOhXMeGDdammT5AE",
      qi: "D9zBrvulvRqgM7LbvEH-J-QF3FsuOfke_BOTjolMZgQ16veiJHp0vD05MdirBaUO4HNsFjLBh8fbfrYMLiJ6BGA7NoUSpHRLsDJzlOP4wrVi1hGiQoyYLNC0b9ZvBqILuumuK8Eu9IYYWBhJbq_ucgBYpBWWUauzNI0m8PhgPCA",
    },
    {
      kid: "HbAAqwFoDaUWM1Dh1vFVKY5l11UPgpWL-NrTNjKEsMM",
      alg: "RS256",
      kty: "RSA",
      n: "ivVReHW9m2qus4SUHGQRu5toDhKwu26mGsY3GDJzu9Hxd80JBSeWgkCVr0_cGzApzETeivcqw8vjNMyUCzdLNm9zG7OjvdlszejYWkGQOAQthKzyA-ljaXJk-tBqz8bFqeodD9npCC2XaNOwfkE-mmJKvo4ZVFRESw9gN0p89jidER15UwxBF-DSSHv-hfTwvDqN8amL_MToe8ZmAgRvdzMs85AFcW3R80ZHz9ZqRkJNUR_6r-Dty04pn1fE5Z8Or1QCNH-PGNiFYk7sesrkqzc7FMW2bfJPNR4LlV918HM8Yc67S18rWpEwx1ByM2p-wS4QXir8oYpo36UJeUic3w",
      e: "AQAB",
      d: "E1t4NXElcCSM4Kob3dac18ce2DMHVpzj27_4BdFlaOkmm5s-4e5xW4S2tVzJGyp68B855x7mYK8i4ASNrQBPZG5jGR1NtpE2xHpmxS_z8LG4S46yChR1ikdqxLvK3VXhzDk2QjKHcWG0gWBX6kaZe3Us113BLouslc43B4zDWqM0w2YR1B3YdNuRARlbZxd7cRpgKKgvCSDzlME2eUz2nET514yePtwrX78h3h3dch52fabxGyIcL-ECUflOSeeBUJLTQLdhzQUJvMl8Bs8xV0YIPaecm7FAKgg3U0PwPyjw_8ojCcH-Gt9NxAoVDYq7wNIwf1dyFyb5FK_GrpdwYQ",
      p: "wCp1OqV9vwPg8p9m6hGNfDYcgyJbClBw6qm--sJ7GRyCqUlzoSEjFu-3hA3IPtFYXO4Z1EN0QuHxUAIQsI96mcZ6f22nuCmt9Fz-UJKnmjzDCQ9cBy3tf1vTxkGL7sAUD3QnwDIZ6jEAKt6Nk865fijC33k1WjXAKrqhxCsuseE",
      q: "uR4nq66W3L4t8uftEL2fT9R0dQcuxdT84-7OBtVG6Sf9MHAt7FdKX5pKrZIVsm6tYaeyv7_atJYE-mUNTsSZ_45Qwops0h0sCAuo8XrFnZ2trdEXr3dDcgehlJJdQD4XsdJvSEU5UByrkvIWzohdknobqGsJ-ubNz7qSwpFapr8",
      dp: "GZMM-vsfWxaXD3MrbSdc3xUMgl9GIn9GJ9Tjd9f-Lf9fXExMOTuBwgGxOL_k0Idn7SY7BcbcaDJNvUopEnZl6KVDlEXxtk7FuenOZsa9y4cepcwHgWUZYIPGEXKTvviNMulQiQGh9UsELLBlwzAV-7ZNCRTGhvT0WDtyX_snQcE",
      dq: "sryo9R1X0L9XwkepIBbWsc-iujQ7NwzVOIclKnfXRdw0nQZTcPU_fFuPa1O321b91WKENpxZ4S9Qkyvq03kEcDnLRGs_cwhzsTkA4Ff4Yp0SSteulN8Eoh84JinEG_lYC3vxssgT9IQaLYHN_5CvOHTqK41eT4F2ivHMLk0GSCU",
      qi: "FaTCaRUs7NGGgEwIu2xk4E3WWzQSbW-b5Saydc8DfPRcqGsD4Ip-IdCcoW_8-x6oRCxcr4ySIyq7LnaoUGkezhw4Vnw8g0in0b1-LfzNeOuDmDfekZtCWbRj4Em7yaLF6JyLA4SD-N4QfRqOU1KTesik0l8CoDuTOFmqfw-jVyY",
    },
    {
      kid: "zZWMl13nwHDI05Cgw-lrYs33A4wM1DhWAzS_m9ILn60",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "v-TRZPwIJnoeo7hg3-Rg_j-_zENyh8onkYvPVZX7gWw",
      y: "khjIPy-emZgK-Gz_mLLDdm9r2cghgHSjOC_PR1Bk2po",
      d: "55jpPzSxpGMhPqwiadyUCW6LpdWstRdu2aNAzBDCLuE",
    },
    {
      kid: "o57sChMkDr-l1-BUnannxFZeUks1_EqdPygtNu7A1ek",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "saMkQ2KxlZ5MYolp1NzVquXVIBwbe3fg5Y5zaVC-99w",
      y: "zZ85F0fyETHIpsE0DrBxIlcQq_tcMpm013VYXccSuFo",
      d: "rcnM6rPYplPzd-adErQXpCL2HUBG1Ep8g7ltMCMCkOc",
    },
  ],
  google: [
    {
      kid: "5xBOHJ33jRPzR0-4utYxyUjPBKxp3QufG41mx9jMtBU",
      alg: "RS256",
      kty: "RSA",
      n: "tlJLBRuSZbYE882J20AFNahSKOPWN-PFOxlUEbUsJSPYFi7iXTk-m5Bpm38cp7_1Re4pKUm-j0jNG73_F2RD5lKqh7R7vjBFlOZ3yPKa79HGEe-3qw7g0kfw3QsnFud6yQPsC-ULLjtI7w6FCNGdjzpd_kvEQ_GtSGMBf-th8CCdfRzO2M1Y5kC4CxOJK7foluG15Kwsvxp_OoidFrrB1wlavRGyp_wcZk-kChYuERqHX6S_bSPL35UoVIZXn-YOY50vEclfj_pXAhXKLzEvj95mto959PGQCQQCU8y__cNutI5EvbQklqIWwtOAmnZCMrEPv9yAsv8zVop6e-Bp1w",
      e: "AQAB",
      d: "Bh2ulbP-Esg9CyXIpsnBIvvLxucVq9MlLeHpMwreFPKTlPLrGnAJTJ0yQkpe3myPCZvs6LHMvIKXZIOPh8d9sC08TKOnbLdpiY5yLxPnwA9wrjkQhTTjj8pAAp7MJ5ob-C38gF_ua6eZLN8t9dcO09vfhLvZEFFFQKvyse5BlhUxNxa2vp-WQzbYjJAgcyXZhsMlrlR4yh3WEFF36ySoKcjXB96u2X_risU7lLGSy8XZQpnYw4WLf7u7KFGBYtGWZWhZ6xQg6oKCdhDn2-tMzIs1oSq41Y2ZtaP4xrn-LQUkZVtNB5Oj1otJvzXgK8qnXX2qy5BQSTFolaBK0W4QoQ",
      p: "342XE94YBQMYtIoGTb9Ac-7edp1dFA_K3vERZX9inrIUf6at-ePOa0YTg-oqDz9JDUa6gFnokWs9Yc-4BDIxh6X6K3Fzd2g9eUSA22DLUUB7jGdiLH335HFt19-hukTf-JymAXz1CQmRnSuIlMAsJweFLiZ-kV5SVWuDhP1GU6c",
      q: "0Miv9BUJXZvckSwZkvFuPpICTBlC7BErgbGB1g3R9HKcB0VvIgeT_m7HjfnThr_pAxHQ4pLN8ux4-bukSizDo6_K2dagqpSQ4swUCPGprFshMJo6QucQHSqQHKo-Lk-M4FFmmIXaxg7BOVZkfsOej8xYvxqcN9n1kn1hxN5mvlE",
      dp: "uQqzPf-9NBDfFzmUhDBFgnD7dYVGMT_tNeKm-rOZhzByZUMriMe26fakWrGuRNamejXMVEeXiR8SPO86K0b81oJddC5BXFpNYB6C5pPVV5kfaxV8HsXaNh5pxKFYdh1iop_PjTXIgcWI4WbSdAYpxdiktZGpfFxtnEUVJTScTMs",
      dq: "RHVZhG4VaRU_KHbOV-lEHc4gZLVvxRoIKvl6OibD7iRaVuQEgaL8etP2KO5-1lM84x3HYVODpiC1tiU5xHyTFawBlpYSjnwyWbtS4m_jE7m500buzZsYJIgdQtjrlKHO7oqiWmahiomx_8v9Hbek2T_G5bqi-IlGRWdJVJUcGVE",
      qi: "TF0qek-AkYCk6XHj5sv-sZ52_DZNVLwHcuJCJsMY8yGmHlUyu8bolZgyddpmeTAKoz-F54uDEN_Y3hJgPR76uEmgHqB7ekqEMXYUKmONbmFF56zRzueskFSSkbGF_OJRziQz7HE6w7k_I09L-Y9LTbHLZ-pBKWiOoulqMLPbTdM",
    },
    {
      kid: "t1CmHdJ2i_CQBjYIKsGhCEhBTIY40-a4f6tmEtOOVbU",
      alg: "RS256",
      kty: "RSA",
      n: "2hz6OgJmOSh5sXrOXf9JC1-3Dook9uDJCRRiCfrI5uWu0UHzt7B-MzZ4woTl1CfV0-P0yoNbJCtT_dGkx9A3QMBkh31DzHHwjQBhAUzQ-HsXosGlx-nx7FDqB9IQ6526f1BebR53seO85JtsCUaEOy4-E_7wTWoSDFoJkPRVVLoAkbKhsdIGzuvSV0QO8BrNXYVoC7Ft09cKm1DH8Wiv1V_xj3mvyqP-KIrzbLmSCuawRZG0-vpRdVldTSinBeTp0b_TynYo0RevgKq3u0eH-7LbHjbGSwict_OAyghg07DV_HOhur4_hZBm56ojjaIGXepIfrEWcfaTbhkqMC15pw",
      e: "AQAB",
      d: "GtPnn0z-P9ePqFnfmkY1ONXsETjCtS8O6zP7nxier2_e4dRH4vctfqUbk2l_T2oa7fYi_OnNQxSlPxoTN5SPx0Ii21t4BGSbXuyGAf_t0DJrxNQmzQEkhZmqP44CEMkU0GYVRzyxIktNx5yqXDW1PAZDEniQHCWI1MYaWR8Eg-gmq-PRK0gAfc1drMo5pnjZkfqedJ_qGN0fwC_IGQdQLI9ZfoYp1DtwKNFw9olArcNKoiZVDZ7TdMcU0nS2j-yw49lCWv8KOt0h3pjXemVXrqVKLRiB7_3Ied6Lv5MM6xQLYWCTa3I7CD3F3Gh1QAFgCsCGOKpx8FGjnxv-ecK0IQ",
      p: "_8GbRQ0nVamuv8Did47L7txTQzlOIOrIo1kTepzAXHttRks97ea_89asAa2bVkgdVIINDN9sjpAPuJ8Se8e3dqZ-am3bk0WUHlfGKZ-DvUWVAtz0jcbgzhxic1nVtNX9GvYtiE_lsl4Vn6frN5ooggw4t2jD2kuyE31XJvZSMxc",
      q: "2lIwCS40XpTO8_fJI8JoXo7IP9cLZ07lixJdDQbu2nQJR2RiHBHmQDyK0yH5MmxwGzfAxJBtLOJZUAc-4cRIaw23Sktg55w9Ivf2jzZiMo9XVQTtxo2g0kVX5of1jdlG6eK8-bDJrGuznyIS5nlYjPwm2WyKewmaiJ5LgWhgR_E",
      dp: "7wq_2yxOJWyxHhxkDybySNC5Kc23zmBjIvmwkRtNV6MtIVRWD7Nqmbd9kRv4Yg6JC2F6XRu-VQklCIP1PKgQO9-lrEf9wIp5xFp5ppGnChKtEb3-_TxzBXHWOsYuThTrunV5XTyADdSOFWlXGeMGFXbi09ohpDi3uiued5YmggU",
      dq: "mk3chaCSgwbJ_sTy9MNC4RIplnV3Kd0pf9HK0ppD10KMDFl2vkAobN5dgDxS1MCvu4z8QfGSOFcCqP12BDums4NOOMRuCUT0MPLw4OefH_0PzJdfNyaCtBsutVECzO70n_oRdqjs4WB948tBcIPzgjH1g1ajybJP9p9q3lvXMQE",
      qi: "IgqcJcZwoTwOIqO508Esk6u0kz9kDWyrQg5sTB7y57pvP6ZrvntL8ahzQuZ4mrUuj7Fe2kmnrp58_en7_4tEQkSmkFfKAGBEYJGBJyvTBy9lZyMt3SgiXuwdiAS0x2FbAXS1B3c30tpyaBcx6ZeUYm4Ewoi1gLkqgms4gJidSkQ",
    },
    {
      kid: "u3JJN6gWab5c19cVH22m6e0l5GkESRNTtglMdeA7EwY",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "JQGu3wyiWy2RM4LdfiFt7vpzcw1iS05LHJrj00AE3pI",
      y: "vCHh3LVqvo04Ipwx96-fNg4741onc6IPKQ3CeUrXVr8",
      d: "uTfKIlMnTRog4wKjjWLKXIlJ1GNmbE5uzH7MzLbLxiE",
    },
    {
      kid: "Bu1Hk2lVYcZ-j0hrEwQS6lef2NlBSlrwTBHEuzZY3lM",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "FjLCOlffalWHhbSkXzUMZjIyOR1E8YQqqWa3DAR22jE",
      y: "vcU4aj4srNMOKZoqTcAiUsfOXE5MSroV78hPpAEf8Gs",
      d: "beBWQ-Prmtd3rmnEEK6Xu78AsgnA9HDn0jiglMHxC2Y",
    },
  ],
  apple: [
    {
      kid: "pmER4ntS_AnZN4TxYGHL0vicugotpdpMnDW2_wZ4WB0",
      alg: "RS256",
      kty: "RSA",
      n: "sdNb0YKQfYDFetHMIpCzZ6ztVzY1k_cEDQaUCksPwHU9daoLI8WxwIKIgxpbrkIsb-EHCYCQTjCCHZcSkR4tsUIP8gRIgiBS_gHidOxgD34xpkJFF0Ul3hHoWFiNruZ3koKoHrfN48u8moIPeVzzWdP-Ikb2Iqi2lACFUAhs4b-5OwHps9ZBYpxGb_gMuIOYksCxIUS2t09DFN8CT7K1veksQHJmMlv0gfdMfReF7UQmGrR34VTVdigrHgmfI8HNbLVzAR8QwcSnFvbJ6MvN3Dh3MS0-33rBJ0T51eZM9l-9LW71g31uHoTgSNLRUSxcaYp88xLo33nOp3s9QnROlQ",
      e: "AQAB",
      d: "B--Op4g3NyEB7x8hiCHDN96Ip8pnoRpP20SOliUCZ3LaX5lk-0XNaHHXpY4nRqmovp3UVaq5bE8PrdvGyT4hCOORvzNMu-EbnKVSr1tRibxDR_Z2JRM1A1BZeTPYFgf7Kkkonb8f8fxu7TBEgFFTG0Ok-DxvEiqx6mOMwrHiXHKoH0Aoh2R9ZbnmGZke-nVWr0SHY_ABlbcP2dIVgHsOmMqMJZLbG2_srIs5lxca6B1ePBqnaHaxwJQq92E_LB-_oTAkTp42jb_SMJyfV41W3uE3AF7GuLM_gbSqqEhkynxIVSEo0lqVbicmRyAtstI3gHInyjZ9pkXyApwDBbZ34w",
      p: "-xu6EfoUwSSTDaqKtrcTNyTMe5UrQE_8U_9nUjbKIpvOlJr_VO91ShWrABi5jNQKqNvy71F-UpHBq1kXOeqEz52t9wcJ5hQ5rznZ4V-B0Efvrh3XjJG9-GbbUrsoumfkjLeBCOBjyuPu15bR8iEdaGbR6edLGLwl_TXxG3Nma6s",
      q: "tUosFq6GKj4LjDtNaC3BDbTIRcl-WRi584ynkKRZEhm7atQy_zRVTZdT-wgBZrYHVHwUqy_0_OusImEHomsp6fQgiTBQkTkV_3wX3KSk1he2YAXdo_6YXLnHvgq1kNWDr9nsvPwDU9go83Hz2F6AK_Iex8tpkomLuagfH5nT7r8",
      dp: "wbFJfcRhbfpAVDJQfVAKSmbgNBOEIT-Ra1l-4TPSB5AXcRl-Co4K8vJzzMdFmROWhVnjsiYyQo6bzQgTmmEDwQHnxrxvLkI7nKYLIoUBJR_YCX6LXaqt1oXAd7hWWjL5YHHL3oT3dPEMss9rclGI1Zc6JCp9Cr9WrlKFgJ8rSbE",
      dq: "Ocq3W1OveW_mBoIxHvDXBiOHZJfjK0vym21PTZDWxCpn0Jps12Y7e0yufOwEZlXI6GnVvOzA0I_gg-Uipeg7qFUmuhUo2eK03IkWokPqOEW-4cV87naO46BlyHNphg5KuJhkG6rK9MOH6nN9JJCbk2bP4Sk7Mneej0TFBzHmmck",
      qi: "cz8TQx9ELtQ22mvRGThUWxSRKfjyGJDED4l_44xocyudViOOaNhFKf3QEQHFaNnhuM31dTaZuAcw-UjY4ZpEDjReSLbvT4eSZvmGQ43d_w_uis4-CnHlMBtOj5UZIIMdX54SA6aXlKiZTlgpFnYsjHXla-_ruoRr6z_Wj_hsv5s",
    },
    {
      kid: "BRLikoGj5yVubZ9dqKI4SgDa7cADJGSboW-qzXvBoFM",
      alg: "RS256",
      kty: "RSA",
      n: "4c7egu1V-icNTDmpY1DI0NyfRc1NRR1C33W9CYULDSNLWb7miIGDgAjbBk2Yn80wJSBnnVFKmuwBZ4XH4ac89P008m9JZlTfs4_vtTYFgnwjL7ZYGETKpZdF2JHZ4rN-Kks2bqPMq5JvI6OukNd8iTJ990pGfkjRT27uIDByi7cdKqcMeScg0Sw9LsDdkx7qPi3CDkpseU4X0kGxruHUBrKoTWoqQJc96avvAJR_1pyhcFSyBKRRRzau4duf_qJrC60e16B5wMq8uzbhUdot1IvuVRxyQHWB16RDul0CS6i6KkpY-P5FPEy1MX3uLk-HBAs3A94IzHXGo4rYhDBHKw",
      e: "AQAB",
      d: "HHHCLsz10SKdNrZmw4d4HHNGLvVLIAMtGtgKfYoAV-HTypTVFmn2Jik3aeZZbPvcbjjURIlqc_R5wtAj2yWFdLj2s_lXziev3D8r63BIJmU7y3VVSI1V16EkH8FTqI6CvJIn460Hia9TB7LFOSKj4eZ13rJBCgRjNXXcUjq4GygzukwK1WpJssIZ94JMlrlVFihNd2qdip8d6MNCZrng_3m6mttWTKLxAGbecC5b3lZ4cAPVr-hvWXoOPCstbeI0xO9H-BTtg5uI5s8nZlu9wvJktlqDOjrePTfu5QjXIi9670wtN7tLiDwp9TEvw9TONMh8xztPdX5m_rrIZoE88Q",
      p: "_z8aYp8BbVPoSJeldlDE59MTerbCSaijeR2qpB-H7Zv5MByh8zpe7-9C-PIXTgVA8gEgfykJqk4LIEfSthFt1Jl2Y99ybGBhiz48rVspJCURUSln6yR0aZ_3jRObclOaDUkaoHbZba8yFfCW1De6JNlBOJX8IAFAYY93rO7wtlE",
      q: "4nmEyHHH1NqwLAws95-xanysTJdc0RzmFHfeMxEKTpE3RefhV-ksBT_776680yehxiY-zDVbkhdQf5oBq4SPKX1MVN_fHUCf4OYlETuDV2e_tsbquudI8eMLRhpaS4ug7bJXyOJhxIqWDMi0dso80Zzt8peeYUWzbw82mD9Q-rs",
      dp: "bBDod-bAMOx8hPeHe19Y7pnEPolQGuWGSMoRrCkZYLVPvFnzC0qkVUtkfIfq7AJ3a76kZpIWYH9oYINoJ-ObL47FvCUnidEIm25_PBpDgeUbvtQcBkdJ7kpnAdjSUIYqzAMufc-z4KdzOizBfxoU-nLtFSsTMu20t1mJnrMPQPE",
      dq: "NRbtdJuPj6swLzMve2DZEzBkp5O382FF4jhzQx9UfjR2c5G29oe3hQeJxJb-trUMrEmc4PwFGksS2Ma-a3moob44nZDZWZ8jm3H38IE1-dBdVbhtoCDFrcZehzF4R0tVD0OGZpYC-zLNl_OYslwYQ7743KyEOSNAu-EiGDCHiC8",
      qi: "RKFMz1wls9cFSXoyvGgoCB01XWZLKjBthhF_6NrBXYfCa7ruLjE8xF77xmVIG-8B5VKovscE5hLmWN2ZkYUSEp6_geF6-evSalwuj67TvZLT3qlPeI3IH3_vAJ5yb4lOObXjtwWq_jWggefS29SOFJSZLc5yZVMj9a58-SFfV4Y",
    },
    {
      kid: "7XS-MEKbMHo6fc_AJhG6A4uls7OgVqGB3cqV2_eTN2w",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "BY8rBCNZ6g6oFngcX5KDxTGHkeMZEiTC5ilXQMgs7e0",
      y: "Ov93I_1pw7eaT3qrcndi9BYUCMyL45UF4RTlzXD2c5c",
      d: "PgQKEjTRGqtYaCE96-sEmzl3cZ-4PqbEyk_B2YKzS28",
    },
    {
      kid: "VXT-VIn0g7tjXac5zX8x-vXNFn7CCTlNC4DEpXiHkDw",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "IL2feHnsPWksCFnkVpW8z4g0cpPEFaOazIRlzsvKj8I",
      y: "gAOtcSy5T8tcSe4N4sfbF1hAHV_-rX4tYeW4eA90rgk",
      d: "BuLob3nsib9NLrLbe4-Ysb-ZqYzm5cfrEIHCTy9Eoes",
    },
  ],
  keycloak: [
    {
      kid: "BJbL9-kJ2kN8bP2tAcBlsA8P0XF9ob-NJsrvj0NaANI",
      alg: "RS256",
      kty: "RSA",
      n: "rat4YX-uO2TtDIM-tubZII285nyQgVb5uEmuYs4kHC89qWtpunJAU4918IF51DUvshxiZrdLpyBdWYKJJdEZ8lj-SUPki7xo8kHhNxhR47v_yGq1yGeMnVYsckcS_E5ru_r0l6GvM4NC0GS14LHuK77ZWLV65jhTXCZe8JboXxcuDOX8sFRAmK_yQJfpgY_Xg5W9EQYecoDFSnt6gQSMCwan09jm8sOuNp6rMGrjGV5NY_FK7TjZQ0udAHSgUYcbx4UW3z6SEmJydXwZWhybYdVXu5omkRwSKrC9TXn1lRdN2lR-xz_6zVniglfW4htheT-2JRIjZWxY_d0ZZaKREQ",
      e: "AQAB",
      d: "xzDDYGHecbyVxiqkVF0mypwnWLl0Q-32lcMB2mnIpqMV8iCGIMhZg-o0svC_K3jYSs6d3hziSDFbWMRTjHvKGZZHP06xrJcbr4GF_COsg8Pj_Ft9UWcw14cmOiKWNJaoiDgtEqJrwDcndA3wyd8ObqXOdA6vwEkukoLNcND2jZne4dgb0-K2KwiHR8ELEEsMcajPSaVz1VcRJ-Y6ceWbWNp9inEbdGMznkl6bOYni5QhzORfd6qXhJsE4YqQ2FPSOA2iQQCoz3RcMdd_XySLSLMOeKebVSLBmpdct9UNuBZJOhQUbTOZkcE1a887kiOSVft5RV4OcfrYnifs-h1Z",
      p: "7rlmSE25vpuzwiV3e4DRIGsMJl2QYjSJGdwsElP2vuyZ89Mwcp6trZ-LT0N2GODjFoYrgFMbwQRPez8MRLCgSjxXf29WkNiMccrDtf856xwdIEDvhW5rEKTv7dhvfKyESuh1XJ7g43cuonQXnNsqnaQTGDU-8ca_B7f275RF5Tc",
      q: "ujzftcIvdwcYcclbGzDqyPULqkRDgaz1CdD7u2PnKx5pv0UfYtu8vwAVay7EE0urWx-Xv94AtmfaGhmVJsZSH4493WPsxJWJ8K8o894h95Psf5et933y5yxIt7ArIA_PAwe1nynRjy_bUxK3qo5J81Hr_49KAU64lRCsJXx1X_c",
      dp: "eOLzs5uAetBX5_GXHrhtrg_nOCpbKg_WeXzv6FwScD5Z-4mvV-uYoXpQTlQoIpMHC-nnb3UmccigAxY7PTGACfeii0qzOGggPqNiFfBnwPIcoa-gWx4-I1CSmwvl8OlfmJs8iyl9UlKRD_zf1DN70hY7ASA9fquZIux6pHmeJ2M",
      dq: "JqFd3fvLkKr-HQwhQ8Cf0tNReh3yysEviru4m6QbXUxPrwcNfZoKyqufxb3Lmh0GDD6_YWMRTsS37tYDpCla-4SrvHJvuE80b6JFomAfN5WNZuH1ifKsIduDseZu65Wb4QsGV197QnIw0kh9pHkjSb9ibn4wYZkMnI76xkPMrP0",
      qi: "dZmofLMjn8XLlDfZ92exNiSZahvfrygEe5orkxXEbTruS4ZduXjpbd0FSK-8PKeBsFR4Ty88_qliLHM5kahSJqCxPJF1tMvIC9gnb-K1HQ6W3E8Z61-Xz8-MQnCoH1smQhGxLV0Qz0JeNDFHUPqIlFdZohPujF-mqEFkPHfgrs8",
    },
    {
      kid: "UIQkPAoyu5HzBg41MhfCFlDkrUhPyLjPI5f-2KkcATI",
      alg: "RS256",
      kty: "RSA",
      n: "s9FtBN1L4grT07Fc8XnvKU3Ao2KPyEtCaC1EDT_-2K2Fu0TwnA4uRI1zbpqQywD2EVFtQ4I6Ufmj1qWEZTFU8EGYv406YkbGeLlJjs5tby0s6PSIdNqalTunTGhMLw-t4J1kpnMMRoAmxzpnuQR0hI02yCGgK9a9kA97uc_tKvxPPZCEA5LdCT_8472y560EgofMts6zVWzHbULXLIveAkcQZ3Jd-etp5XlkUyiBn-ppFI8J1xBYf0xU4ukxedKmFVTSy6VrFIScEtwfgPMEVaoAo7XDaQ6ISTyTgdpAvLQmJCGaRc4WCPyXpP79v9tvljges96k14OZC7u2xykNLQ",
      e: "AQAB",
      d: "J2lTV6mZJCXzX4aUNGjhPlBIVIcZtHCqUWL6c1z_YkZF9VGa2tlQ0r2d-zPtYFEJnaoXJKC6X5Uzj6wfZH53e2ElNXaiwT956KPTt3UPDzr7iONvtQzkrKiydlC1werR1VUp5kF5A0q7NRdb_HU5hIPe6eZU0Mb0LUr3dzZXaQAdvuIOLJsOq9dAW6XwKinOy5jY7MXA_9l9pUFc1xMDc67eR-X8RWrxb65FGiq5cSQX4JA0p4oxcozeiHSt5W2f9f1eJqH0DfgXRaDbBTBZQQBVyuZTLxs18SDyHqa50gshcKbtFmafziJ7iiYU9AdQjWV_t3uxmWjTsD_mqNsOEQ",
      p: "4ko9ZorqqkDIarmMx9YnU-3xesZnwzcfYjlfTP7gVZ4bn6BDIHyfrNTR8a9PiZGA83bylWOmsm0NPy0UsnO98OrtMZJcwl74Z5RgQg7_wZFxahL9V4BFTB6kuin1ZRP-Pr1y6t9KmUZK_v_LfjHjeoTGWL3SYs05Jx7r1rnax78",
      q: "y207pF_lziRlY31qhfp16vD8CmgxFTtFz9-2u5L5jLEe7g4vGDc7gUcf129z9X4GEF-ERB8G0vhl_U5CvSaGrLBnstUMlePiFipcM3R05H94RWFh1tFcSUcOs6NyEuUBH5S6jzmtgjx8hvRNrW1idAWS5yoZf51RROwbP1oyRhM",
      dp: "RZlp6ykc5gKI4fJx72DZtcHAfO-bKHrCx1Y4Dplx7EN14ZHMM6jA_8pxTDGMeBZtn_Rcxj_hHI3X_i9iZ0ScDgZjr9SBfTLymgET3h144lNWm7Z9fzUvmyrtpWiUVmNg1nE0cDL_Yccx9946-3Rir-M4kkDH_aV7R6IGDYQaW0c",
      dq: "Rg6mXaORFv8905ebmex5s6Guiz76uF8jWcWnvs2NF8Df8Af-fA55dboy4xTFEKSIHhdnC7bLuNhG94d-QHoGI27VJ6droCtM72lDO409vHuRxgMVmM-dQrcv_vmpDYzEaEXmQfERKir-j9OO9M0Y_O_2eZnsEiDxnhTaBWVgrvU",
      qi: "Ynyr1OblK4t73HOP8Ygk9-pOQesHauxa8XLEg9_mnlpaWRPKsLmX4FeXN2dK9f65oohju83kbbnAz1m3w_dkZjPOF6xkhNTBcqkQvsV0eARo5CWlj_oQeJYh8p6nM0PXtpKutVzwZxJOruYcBFrhfNZ6sVwkps5rBS8oiCHSM_Y",
    },
    {
      kid: "ANbZntcG59vFLFCOYpM3rghKI-OH3qyqeTlcyoUfvkc",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "Bhp5CNwD7diJXIEvEAJbAwu2ZEkBZOR9qDfkuvOnBJE",
      y: "2oP0chxQJq8cK-BPONlqE-w_TVIzllzxNUdzne4vL7Q",
      d: "Nrf5ex7fXzzevGg93v2BvkKrwl4tXCdVMGuqG04zNRY",
    },
    {
      kid: "KtelIfdS-gjoBr1pvHmwR40GOB8Fmpo0vbfZqTCHZ8M",
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
      x: "9ODfsrxJoVcM50-r6qm7wXLZunztMbdZ4VnxNiTylTQ",
      y: "_0SddljoL4uAjoxTLv-x7RfWgN_Z-WQ8Yg3BYkNJJek",
      d: "3w1giPxy7fpwTjsaWfS1QmuDwDvTPsq90UZSdrkHwQU",
    },
  ],
} as const satisfies Record<string, readonly PrivateSigningJwk[]>;

/** Keys that were published and then removed from every development JWKS (fault `removedKey`). */
export const DEVELOPMENT_RETIRED_KEYS = [
  {
    kid: "7izt-bZB_ybaAb6BKODEPhXMx9SwP0lFEpOkKHMiklw",
    alg: "RS256",
    kty: "RSA",
    n: "vnqtcD7D8w6xPFvlz6fFZpq89FjhG7AulxLsQyE79cStcobWK8GNTBgFY1VLb1DcsYLsOMQe6AH_jWb3RLBgWhRqlZPwnVaCTkMThPkwHuRDLR255i6eyGyRNZRvl7WOtmT2sLUT7XLLv-AKg8T5gjGn7ArTOAD4234BK9M3GCtelI49m8R7OE9q1oUgnDOo_PmCPq8mGY9EnWAfr1ObMAAO92f6t81ZsTWzKa6_q_a74GUjtnOcrhfh2YlrDvPMipJ5eF3KZwCjzFEdNZiz1jqyBKDXwUQi64tZqrEHUt-pYCaFKt7EgGs1iIRSNkJePby0E8a4wB8w7Dx7kd85DQ",
    e: "AQAB",
    d: "TJrf59WGTtko1IKNAR-TFznCJm8cUVtg0WdN142lJKltrDKoLb7QybqbaCCkjucxar6hrA7L8zjigwbXCSv6BCBT4UY3Lb_d9gWp8v-Yp8PbdGiRHA7B0w8-sxK4coYVGCuwvs6EbimN4eQDtozgX8kCpL6RxeM2MmgRpoNyk-gjqBt_GZ9DR2CPLCNaPl4Wj1eHThMlAtxMgcCy28N2BkXeWf7NmN2qtheIfso3ObpI6TN94mH0nApB7qxKiFmTbl4vA9ivJv3bKNPpneja6s1KYorhuYA4fJYCOHSn4fpaCs-Ma-bi_latmfVIBPLjDU5h8gF8L7Q6-ogYQ8fZjQ",
    p: "3uE2FYBgi91Tl4CUgkGvRuZDyovRMTPn0I_LW_D5hux1hcA_wq1SnCecyjjI_UPXIB0I4G1yihH_1y6SLiUq2CJVS8v-LO6NgjOxnwLRxDePHAzwCGjhizgwv12jjXVnCt7ITW4zhfAF_dgQ8Qo7tRv-xcFL0B6FpKRVs_l-uiM",
    q: "2sjixozy44dacTNbdxte_VfuK_bzBdiJ8Tsh0UnVil0-AzgZBbjhNuQ0nqKREFBGC6PZI6vX1Q9RalbovBiSB_Cto5sRd01pixIIPbeEZ7PNoxTYitjRYHTFBJffGBwE7g-skYv5yHRPJpGzfnGv4vg3LFqf_YMMjOyZvWNm-w8",
    dp: "xg6fvw-ru95cMB9k2TOBjKGG0HDa3rxfXajKb9N-CfYKoWarwlW_OWDCJbm8ccNdYf4rKzRXOnawQQnzgOoqXpJz9b07C7aZLYC-cK1StukgVS7yBqcc9lhiiUuu0T_o53H90UECrB0VVfQxaeFMGa7dAeK5eiIFZL9cIWiuwr0",
    dq: "zXVDieQJoOSWaaIqLgNVRCMUNtNVS9MbT6ARVQK6d5KyzsEatoX1ceADDkpqYmCQNxQqsVYKfTpCYdO2AhYs5Sn_VpokX94h1Ikdlh_GRsDSx2inJlUQ4z0lW_fneTOu6YVssM47xyR6xCSl5IONAl_JKGz-vEsaOSlkAzfbGL8",
    qi: "OO45M_WYhNCX2u1ayTAomMRzPXUZepRsURX5j77xPINlsEIdboMR6II9bghvbQeIEXZBjSDrcyXA6afksn7BnYYTjMePG4rItuWKex1137HGvSJtmtekS--u0RD592wYJzJHEPXMYyEwT4Z9XN5671Rn9Ne_uygvCMcffSSCGUU",
  },
  {
    kid: "5KTRTVHFrAcwpairJDP_UPWj2woTjLeqxYopg0H31yY",
    alg: "ES256",
    kty: "EC",
    crv: "P-256",
    x: "-4kN4T5luQ_1ZRU5_YHAnVQuUZNjPN6J67cfrShiMhg",
    y: "kZjEH-rXyBrqBFc4UAsh24dQ4wW6dptscaQDLXKbfiM",
    d: "hQLOiloL44jCFsqYdquL0OqUExraSbTAKDuTUj2zdT8",
  },
] as const satisfies readonly PrivateSigningJwk[];

/** Keys that were never published anywhere (fault `unknownKey`). */
export const DEVELOPMENT_UNPUBLISHED_KEYS = [
  {
    kid: "BwgZQku4gQy1_9EFYZnENCERG2emYoWthDxKC_QTFQY",
    alg: "RS256",
    kty: "RSA",
    n: "vCOmLDyq1cy4LbIfz3hnzfbgztZS6u-Xxx9bt07308foCdfh4EMUNmde8onT7lMMLLq7s8Y0KX-27YmUf3JCBRAymu78_rHAk9ky3TJBQuKsqlRA8R0So015mu26vgQ8UsUycREUCMWcprXtjMslTefGMXomxJ9Ivplkd5eO3uhABQBgQSqLChqAn69vXxQVJ0uH36jQ9Q_Q__MjqtfkI3v0io_QfY1KSAL4WldY26SDZmy8IRCCjb9-K2h8HFjfUwfN8iUFMGtuuOkiDznlnQmjoSM9qRZXVScPC-L1yu_V9NwI51_1nweVakdd7lDqOCrh9rC1W80VNao6ovKmew",
    e: "AQAB",
    d: "CwlaU6kBaoZWXZPf6tdI25u6Z1fKSG7iq_Mqea_fuOQ2t_EaloHI20IoHzk3nfjwM2WG4k5ju_V6gSe7dth4h_yBw3X2kGhUADhTFAfBLU_HyjwkDSDj-YFve0er1z6_XSmlQl26m6MgA-WTOFmoaBALH9bnFEy1wzyTWLKi1m-WlsEkcshxesqsBsyCsgvTYMUVEUgGRvQit7rxAIKStYUKmzNZpNABLn4rS6NntifhtiHWbaw2JOCXlZwXgrZ6TlmTeWUyDBjzImX8ETYjMT875ODtzBY8PPI3RTaOj89s_9QXC_LCpUI61ScmRnWF5HmsZ4H3OkG_O25iZGNl4Q",
    p: "6wjiBw9Z1fEYSO52BAdOZ9XiTNqegmSIuiBxq1hwr968hUt9gVMEKdrqCbLjSGFcMaS7I1zLcu4_d6VI8OMAD_3Wei5k9_2sPKhJ4ekarcOGUZANsOnXmclbe_F9DxF09N4syJCQFy4JL7X9PGJ_xIDoMO5bQozc7O82kKGg9mE",
    q: "zOvjiYJ2GJlIFMS7d5_rZ49f2jV6NIek19KTsyf7Ls1Wcv4Ve4lhm1DOoigW2avRd62MIvh_ze1tJnCR72LmJJxqxYiCIMF606-HJdVWF_YeITdq8CEpWAUF28oSA7uUD_u-V4ruMZv8KRVG8IeaHygwwQBzoXjfvnQ5RxHQUls",
    dp: "DPFjSRI-Vzq8pJ-FHjmsxqkPmj3bxsB0ixNoTxBCvFyesxRyJ-IDc66bfsc8HutFoXI53_unNIAMPLF8b8-AXGEVI4tUgheVGY4G64rjrjf7OJifOGPYPJ7LC-tDgMXsU-O8QZs8ZBpj5R23gVDHSnHy12b43ZRWQjH2JkbQT2E",
    dq: "s0gZXQAHxEOunYT1IpaGBKeaS7WHwhd-b9fqos5y4qKBZL_JGbi67YCIF7SNMUkyTMtIFHxmjEqRuRS5iL907Ejw3PsuJexAQp2J1t7LoNER0SvD4myQ2FIkqwMiOaPNySINiFejR0HaHjNgSiXJAENQTDrR705qKh1S00vRf4s",
    qi: "WgHzJ5BakT3QRLfw5oWzyS9cCnFXNmOEz-4qMD92p7Zz5bwK_Q7GaiIoF63rZR6K2Oa1UN-Zh4PzxTaZuNeTmsY4lFVKLZyBbiQDgq7R8_fgfyoyPy8HRWwDDpKJxD7-JcHWWeLDPxErwpdUvku1Cd54l7KbP2UniWJARUOLyyY",
  },
  {
    kid: "wzYiBRLuXN7cq0FNgGyYiNl-YUuwxnv1JaKjW2xM4-8",
    alg: "ES256",
    kty: "EC",
    crv: "P-256",
    x: "sIJ7oKZpKWvE9EwtdJ7CxGxPjCv638bBzrohiZ9kLPc",
    y: "wPt7OASy9MmAqC3NcZ1non0O4jBthyVl1_RQzlZL7dg",
    d: "FOPus-xPYIGMU1Nk_u0MM5e9Tfo9rQv3T9HTE2TJjMI",
  },
] as const satisfies readonly PrivateSigningJwk[];

/**
 * The private key the Apple-style development client signs its client secret with (team
 * `DEVTEAM001`, key id `DEVKEY0001`). The relying party holds it in local modes, as it would
 * hold the key downloaded from Apple; the issuer only knows the public half.
 */
export const DEVELOPMENT_APPLE_CLIENT_KEY = {
  kid: "FSkRfnVqEr_SC8nq2Czqv_fXg21hBz5p6bPtNlrYgU4",
  alg: "ES256",
  kty: "EC",
  crv: "P-256",
  x: "7svCZH3cIPBW1-ZibIjFMpax-voTnYTMyyv1JlHOX6g",
  y: "ownN0a5ZOySyQvrSjiaFwS30cE8BrbTzD6qC7JySilA",
  d: "jXHLAxYfGLvHPHuGBvTWkdHP42oeQs3KShVTAG6wTHc",
} as const satisfies PrivateSigningJwk;
